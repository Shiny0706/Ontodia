import * as Backbone from 'backbone';
import { each, size, values, keyBy, defaults, clone, sortBy, take, filter, difference, union, uniqBy} from 'lodash';
import * as joint from 'jointjs';

import {
    Dictionary, LocalizedString, LinkType, ClassModel, ElementModel, LinkModel, PropertyCount,
    ConceptModel,
} from '../data/model';
import {DataProvider} from '../data/provider';
import {BFSConceptModel} from '../data/model';

import { LayoutData, LayoutElement, normalizeImportedCell, cleanExportedLayout } from './layoutData';
import { Element, Link, FatLinkType, FatClassModel, RichProperty } from './elements';
import { DataFetchingThread } from './dataFetchingThread';

export type IgnoreCommandHistory = { ignoreCommandManager?: boolean };
export type PreventLinksLoading = { preventLoading?: boolean; };

export const HAS_RELATION_WITH_IRI = 'http://www.semanticweb.org/tuyenhuynh/ontologies/2017/1/kce#hasRelationWith';
export const IS_A_IRI = 'http://www.semanticweb.org/tuyenhuynh/ontologies/2017/1/kce#is-a';
export const SUB_CLASS_OF_IRI = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
export const THING_IRI = "http://www.w3.org/2002/07/owl#Thing";

type ChangeVisibilityOptions = { isFromHandler?: boolean };

/**
 * Model of diagram.
 *
 * Properties:
 *     isViewOnly: boolean
 *
 * Events:
 *     state:beginLoad
 *     state:endLoad (diagramElementCount?: number)
 *     state:loadError (error: any)
 *     state:renderStart
 *     state:renderDone
 *     state:dataLoaded
 *     state:linksInfoCreated
 *
 *     history:undo
 *     history:redo
 *     history:reset
 *     history:initBatchCommand
 *     history:storeBatchCommand
 */
export class DiagramModel extends Backbone.Model {
    graph = new joint.dia.Graph();

    dataProvider: DataProvider;

    classTree: ClassTreeElement[];
    private activeConceptTree: ConceptModel;

    private classConceptTree: ConceptModel;

    private classesById: Dictionary<FatClassModel> = {};

    private conceptsById: Dictionary<ConceptModel> = {};
    private concepts: ConceptModel[] = [];
    private paths: ConceptModel[][];
    private propertyLabelById: Dictionary<RichProperty> = {};

    private nextLinkTypeIndex = 0;
    private linkTypes: Dictionary<FatLinkType>;

    private linksByType: Dictionary<Link[]> = {};

    private classFetchingThread: DataFetchingThread;
    private linkFetchingThread: DataFetchingThread;
    private propertyLabelFetchingThread: DataFetchingThread;

    private keyConcepts: ConceptModel[];

    constructor(isViewOnly = false) {
        super();
        this.set('isViewOnly', isViewOnly);
        this.initializeExternalAddRemoveSupport();
        this.classFetchingThread = new DataFetchingThread();
        this.linkFetchingThread = new DataFetchingThread();
        this.propertyLabelFetchingThread = new DataFetchingThread();
    }

    isViewOnly(): boolean { return this.get('isViewOnly'); }

    get cells(): Backbone.Collection<joint.dia.Cell> { return this.graph.get('cells'); }
    get elements() { return this.graph.getElements() as Element[]; }
    get links() { return this.graph.getLinks() as Link[]; }

    getElement(elementId: string): Element | undefined {
        const cell = this.cells.get(elementId);
        return cell instanceof Element ? cell : undefined;
    }

    getLinkType(linkTypeId: string): FatLinkType | undefined {
        return this.linkTypes[linkTypeId];
    }

    linksOfType(linkTypeId: string): ReadonlyArray<Link> { return this.linksByType[linkTypeId] || []; }

    sourceOf(link: Link) { return this.getElement(link.get('source').id); }
    targetOf(link: Link) { return this.getElement(link.get('target').id); }
    isSourceAndTargetVisible(link: Link): boolean {
        return Boolean(this.sourceOf(link) && this.targetOf(link));
    }

    undo() { this.trigger('history:undo'); }
    redo() { this.trigger('history:redo'); }
    resetHistory() { this.trigger('history:reset'); }
    initBatchCommand() { this.trigger('history:initBatchCommand'); }
    storeBatchCommand() { this.trigger('history:storeBatchCommand'); }

    private initializeExternalAddRemoveSupport() {
        // override graph.addCell to support CommandManager's undo/redo
        const superAddCell = this.graph.addCell;
        this.graph['addCell'] = (cell: any, options: any) => {
            if (cell instanceof Element || cell instanceof Link) {
                superAddCell.call(this.graph, cell, options);
            } else if (cell.type === 'link') {
                this.createLink({
                    sourceId: cell.source.id,
                    targetId: cell.target.id,
                    linkTypeId: cell.typeId,
                    directLink: cell.directLink,
                    suggestedId: cell.id,
                    vertices: cell.vertices,
                });
            } else if (cell.type === 'element') {
                const {id, position, angle, isExpanded} = cell as LayoutElement;
                const element = new Element({id, position, angle, isExpanded});
                element.template = placeholderTemplateFromIri(cell.id);
                superAddCell.call(this.graph, element, options);
                this.requestElementData([element]);
                this.requestLinksOfType();
            } else {
                superAddCell.call(this.graph, cell, options);
            }
        };
        // listen to external add/remove calls to graph (Halo's remove for example)
        this.listenTo(this.graph, 'add', (cell: joint.dia.Cell) => {
            if (cell instanceof Link) {
                const linkType = this.getLinkType(cell.get('typeId'));
                linkType.set('visible', true);
            }
        });
        this.listenTo(this.graph, 'remove', (cell: joint.dia.Cell) => {
            if (cell instanceof Link) {
                const {typeId, sourceId, targetId, directLink} = cell;
                this.removeLinkReferences({linkTypeId: typeId, sourceId, targetId, directLink});
            }
        });
    }

    createNewDiagram(dataProvider: DataProvider): Promise<void> {
        this.dataProvider = dataProvider;
        this.trigger('state:beginLoad');

        return Promise.all<any>([
            this.dataProvider.classTree(),
            this.dataProvider.linkTypes(),
        ]).then(([[classTree, conceptTree], linkTypes]: [[ClassModel[], ClassModel[]], LinkType[]]) => {
            this.setClassTree(classTree);
            this.initLinkTypes(linkTypes);
            this.trigger('state:endLoad', 0);
            this.initLinkSettings();
            return this.initDiagram({preloadedElements: {}, markLinksAsLayoutOnly: false});
        }).catch(err => {
            console.error(err);
            this.trigger('state:endLoad', null, err.errorKind, err.message);
        });
    }

    private initLinkTypes(linkTypes: LinkType[]) {
        this.linkTypes = {};
        each(linkTypes, ({id, label}: LinkType) => {
            const linkType = new FatLinkType({id, label, diagram: this, index: this.nextLinkTypeIndex++});
            this.linkTypes[linkType.id] = linkType;
        });
    }

    importLayout(params: {
        dataProvider: DataProvider;
        preloadedElements?: Dictionary<ElementModel>;
        layoutData?: LayoutData;
        validateLinks?: boolean;
        linkSettings?: LinkTypeOptions[];
        hideUnusedLinkTypes?: boolean;
    }): Promise<void> {
        this.dataProvider = params.dataProvider;
        this.trigger('state:beginLoad');

        return Promise.all<[ClassModel[], ConceptModel], LinkType[], PropertyCount[]>([
            this.dataProvider.classTree(),
            this.dataProvider.linkTypes(),
            this.dataProvider.propertyCountOfClasses(),
        ]).then(([[classTree, rootConcept], linkTypes, propertyCount]) => {
            this.setClassTree(classTree);
            this.classConceptTree = rootConcept;
            this.setConceptTree(rootConcept, propertyCount);
            this.initLinkTypes(linkTypes);
            this.trigger('state:endLoad', size(params.preloadedElements));
            this.initLinkSettings(params.linkSettings);
            return this.initDiagram({
                layoutData: params.layoutData,
                preloadedElements: params.preloadedElements || {},
                markLinksAsLayoutOnly: params.validateLinks || false,
                hideUnusedLinkTypes: params.hideUnusedLinkTypes,
            }).then(() => {
                if (params.validateLinks) { this.requestLinksOfType(); }
            });
        }).catch(err => {
            console.error(err);
            this.trigger('state:loadError', {statusText: 'SPARQL endpoint not found'});
        });
    }

    exportLayout(): {
        layoutData: LayoutData;
        linkSettings: LinkTypeOptions[];
    } {
        const layoutData = cleanExportedLayout(this.graph.toJSON());
        const linkSettings = values(this.linkTypes).map((type: FatLinkType) => ({
            id: type.id,
            visible: type.get('visible'),
            showLabel: type.get('showLabel'),
        }));
        return {layoutData, linkSettings};
    }

    setRegime(regime: string) {
        this.set('regime', regime);
        if(regime === 'class') {
            this.setActiveConceptsTreeToClassConceptTree();
        }
    }

    /**
     * Reset concept tree, remove virtual links
     */
    setActiveConceptsTreeToClassConceptTree() {
        this.activeConceptTree = this.classConceptTree;
        this.resetConceptList();
        let path: ConceptModel[] = [];
        this.virtualLinks = [];
        this.paths = this.calcAllPaths(this.activeConceptTree, path);
    }

    setConceptTree(rootConcept: ConceptModel, propertyCount: PropertyCount[]) {
        this.activeConceptTree = rootConcept;

        // Reset concept list and concept dictionary
        this.resetConceptList();

        // Update property count of concepts
        each(propertyCount, (item) =>  {
            if(this.conceptsById[item.id]) {
                this.conceptsById[item.id].propertyCount = item.count;
            }
        });

        let path: ConceptModel[] = [];
        this.paths = this.calcAllPaths(this.activeConceptTree, path);
    }

    private resetConceptList () {
        this.conceptsById = {};
        this.concepts = [];

        let addConcept = (concept: ConceptModel) => {
            this.conceptsById[concept.id] = concept;
            this.concepts.push(concept);
            each(concept.children, child => {
                addConcept(child);
            });
        };

        // Reset concept list and concept dictionary
        addConcept(this.activeConceptTree);
    }

    private calcAllPaths(start: ConceptModel, path: ConceptModel[]): ConceptModel[][] {
        let result: ConceptModel[][] = [];
        if(path.indexOf(start) < 0) {
            let currentPath: ConceptModel[] = clone(path);
            currentPath.push(start);

            let subConcepts: ConceptModel[] = start.children;
            if(subConcepts.length == 0) {
                result.push(currentPath);
            } else {
                each(subConcepts, subConcept => {
                    let subResults: ConceptModel[][] = this.calcAllPaths(subConcept, clone(currentPath));
                    each(subResults, subResult => {
                        result.push(subResult);
                    });
                });
            }
        }

        return result;
    }

    private setClassTree(rootClasses: ClassModel[]) {
        this.classTree = rootClasses;
        const addClass = (cl: ClassTreeElement) => {
            this.classesById[cl.id] = new FatClassModel(cl);
            each(cl.children, addClass);
        };
        each(rootClasses, addClass);
    }

    private initDiagram(params: {
        layoutData?: LayoutData;
        preloadedElements: Dictionary<ElementModel>;
        markLinksAsLayoutOnly: boolean;
        hideUnusedLinkTypes?: boolean;
    }): Promise<void> {
        const {layoutData, preloadedElements, markLinksAsLayoutOnly, hideUnusedLinkTypes} = params;
        return new Promise<void>((resolve, reject) => {
            this.graph.trigger('batch:start', {batchName: 'to-back'});

            this.listenToOnce(this, 'state:renderDone', () => {
                if (hideUnusedLinkTypes) {
                    this.hideUnusedLinkTypes();
                }
                this.graph.trigger('batch:stop', {batchName: 'to-back'});

                resolve();
                // notify when graph model is fully initialized
                this.trigger('state:dataLoaded');
            });

            this.initLayout(layoutData || {cells: []}, preloadedElements, markLinksAsLayoutOnly);
        });
    }

    private initLinkSettings(linkSettings?: LinkTypeOptions[]) {
        if (linkSettings) {
            const existingDefaults = { visible: false, showLabel: true };
            const indexedSettings = keyBy(linkSettings, 'id');
            each(this.linkTypes, (type, typeId) => {
                const settings = indexedSettings[typeId] || {isNew: true};
                const options: PreventLinksLoading = {preventLoading: true};
                type.set(defaults(settings, existingDefaults), options);
            });
        } else {
            const newDefaults = { visible: true, showLabel: true };
            const options: PreventLinksLoading = {preventLoading: true};
            each(this.linkTypes, type => type.set(newDefaults, options));
        }
    }

    private initLayout(
        layoutData: LayoutData,
        preloadedElements: Dictionary<ElementModel>,
        markLinksAsLayoutOnly: boolean,
    ) {
        this.linksByType = {};

        const cellModels: joint.dia.Cell[] = [];
        const elementToRequestData: Element[] = [];

        for (const layoutCell of layoutData.cells) {
            let cell = normalizeImportedCell(layoutCell);
            if (cell.type === 'element') {
                // set size to zero to always recompute it on the first render
                const element = new Element({...cell, size: {width: 0, height: 0}});
                const template = preloadedElements[cell.id];
                if (!template) {
                    elementToRequestData.push(element);
                }
                element.template = template || placeholderTemplateFromIri(cell.id);
                cellModels.push(element);
            } else if (cell.type === 'link') {
                const link = new Link(cell);
                link.layoutOnly = markLinksAsLayoutOnly;
                link.typeIndex = this.createLinkType(link.typeId).index;
                cellModels.push(link);
            }
        }

        this.requestElementData(elementToRequestData);
        this.trigger('state:renderStart');
        this.graph.resetCells(cellModels);

        for (const link of this.links) {
            this.registerLink(link);
        }
    }

    private hideUnusedLinkTypes() {
        const unusedLinkTypes = {...this.linkTypes};
        for (const link of this.links) {
            delete unusedLinkTypes[link.typeId];
        }
        for (const typeId in unusedLinkTypes) {
            if (!unusedLinkTypes.hasOwnProperty(typeId)) { continue; }
            const unusedLinkType = unusedLinkTypes[typeId];
            unusedLinkType.set('visible', false);
        }
    }

    createElement(idOrModel: string | ElementModel): Element {
        const id = typeof idOrModel === 'string' ? idOrModel : idOrModel.id;
        const existing = this.getElement(id);
        if (existing) { return existing; }

        const model = typeof idOrModel === 'string'
            ? placeholderTemplateFromIri(idOrModel) : idOrModel;
        const element = new Element({id: model.id});
        // Assign temporary template for element. The template with properties, types will be updated
        // after calling onElementInfoLoaded
        element.template = model;
        this.graph.addCell(element);
        return element;
    }

    /**
     * Load data of ui elements: element's id, label, types, properties(object properties, data properties and their values)
     * @param elements
     * @returns {any}
     */
    requestElementData(elements: Element[]) {
        return this.dataProvider.elementInfo({elementIds: elements.map(e => e.id)})
            .then(models => this.onElementInfoLoaded(models))
            .catch(err => {
                console.error(err);
                return Promise.reject(err);
            });
    }

    /**
     * Load links that related to all elements in diagram
     * @param linkTypeIds
     * @returns {any}
     */
    requestLinksOfType(linkTypeIds?: string[]) {
        let linkTypes = linkTypeIds;
        if (!linkTypes) {
            linkTypeIds = values(this.linkTypes).map(type => type.id);
        }
        return this.dataProvider.linksInfo({
            elementIds: this.graph.getElements().map(element => element.id),
            linkTypeIds: linkTypeIds,
        }).then(links => {
            each(links, link => {
                link.directLink = true;
            });

            this.onLinkInfoLoaded(links);
        })
        .catch(err => {
            console.error(err);
            return Promise.reject(err);
        });
    }

    /**
     * Create virtual links between key concepts
     */
    public createVirtualLinksBetweenVisualizedConcepts(concepts: ConceptModel[]) {
        let virtualLinks: LinkModel[] = [];

        each(concepts, concept => {
            if(concept.parent.length) {
                let sortedParents = sortBy(concept.allSuperConcepts, function(concept: ConceptModel){
                    return -concept.level;
                });

                for(let i = 0; i < sortedParents.length; ++i) {
                    if(concepts.indexOf(sortedParents[i]) >= 0) {
                        let delta = concept.level - sortedParents[i].level;
                        if(delta > 1) {
                            virtualLinks.push(this.constructVirtualLink(concept.id, sortedParents[i].id, false));
                        }
                        break;
                    }
                }

                if(concept.parent.length == 1 && concept.parent[0].id === THING_IRI) {
                    virtualLinks.push(this.constructVirtualLink(concept.id, concept.parent[0].id, true));
                }
            }
        });
        this.virtualLinks = virtualLinks;
        this.onLinkInfoLoaded(virtualLinks);
    }

    private virtualLinks: LinkModel[] = [];

    public removeVirtualLinks() {
        each(this.links, link => {
            if(!link.directLink) {
                link.remove();
            }
        });

        each(this.virtualLinks, linkModel => {
            this.removeLinkReferences(linkModel);
        });
    }

    private constructVirtualLink (sourceId: string, targetId: string, directLink: boolean) : LinkModel {
        let regime: string = this.get('regime');
        let linkTypeId: string;
        if(regime === 'individual') {
            linkTypeId = targetId === THING_IRI ? IS_A_IRI: HAS_RELATION_WITH_IRI;
        } else {
            linkTypeId = SUB_CLASS_OF_IRI;
        }
        return {
            linkTypeId: linkTypeId,
            sourceId: sourceId,
            targetId: targetId,
            directLink: directLink,
        };
    }

    private NC_CONSTANT = 0.3;
    private WEIGHT_BASIC_LEVEL:number = 0.66;
    private WEIGHT_NAME_SIMPLICITY: number = 0.33;
    private WEIGHT_LOCAL_DENSITY = 0.32;
    private WEIGHT_GLOBAL_DENSITY = 0.08;
    private WEIGHT_SUBCLASSES : number = 0.8;
    private WEIGHT_PROPERTIES : number = 0.1;
    private WEIGHT_INSTANCES: number = 0.1;
    private WEIGHT_CO: number = 0.6;
    private WEIGHT_CR: number = 0.4;
    private RATIO_DISTANCE = 0.1;
    private WEIGHT_GDL = 0.5;
    private LOAD_AMOUNT = 5;
    private maxAGlobalDensity = 0;

    /**
     * Extract key concepts by using algorithm Key Concepts Extraction
     *
     * @param n - number of key concepts to extract
     * @return - key concepts
     */
    public extractKeyConcepts(n: number): ConceptModel[]{
        this.calcDensityOfConcepts();
        this.calcNaturalCategoryValueOfConcepts();
        this.calcScoreOfConcepts();

        if(n >= this.concepts.length) {
            this.keyConcepts = this.concepts;
        } else {
            // Sort concepts by score
            this.concepts = sortBy(this.concepts,[function(concept: ConceptModel) {
               return -concept.score;
            }]);

            let bestConceptSet: ConceptModel[] = take(this.concepts, n);

            // Calc contribution of each concept in bestConceptSet and average value of them
            let avgContribution = this.calcContributionOfConcepts(bestConceptSet);

            // Calc overallScore of each concept in bestConceptSet and average value of them
            let avgOverallScore = this.calcOverallScoreOfConcepts(bestConceptSet);

            // Remain concepts after taking best concepts
            let remainConcepts: ConceptModel[] =  difference(this.concepts, bestConceptSet);

            for (let i = 0; i < remainConcepts.length; ++i) {
                // Find concept with the worst overall score
                let worstOverallScoreConcept = this.findConceptWithWorstOverallScore(bestConceptSet);
                // Exclude worst concept
                let excludedWorstScoreConceptSet = difference(bestConceptSet, [worstOverallScoreConcept]);

                // Create new conceptSet to compare scores with current best concept set
                let newConceptSet = union(excludedWorstScoreConceptSet, [remainConcepts[i]]);

                // Calc contribution of all concepts in newConceptSet
                let avgContribution1 = this.calcContributionOfConcepts(newConceptSet);

                // Calc overallScore of all concepts in newConceptSet
                let avgOverallScore1 = this.calcOverallScoreOfConcepts(newConceptSet);

                // Compare score of two sets
                if(avgOverallScore1 > avgOverallScore && avgContribution1 >= avgContribution) {
                    bestConceptSet = newConceptSet;
                    avgContribution = avgContribution1;
                    avgOverallScore = avgOverallScore1;
                }
            }

            this.keyConcepts = bestConceptSet;
        }

        return this.keyConcepts;
    }

    public loadMoreConcepts(conceptId: string) {
        let concept: ConceptModel = this.conceptsById[conceptId];
        let unShownConcepts = filter(concept.allSubConcepts, function(subConcept: ConceptModel) { return !subConcept.presentOnDiagram; });
        unShownConcepts = sortBy(unShownConcepts,[function(concept: ConceptModel) {
            return -concept.score;
        }]);
        return take(unShownConcepts, this.LOAD_AMOUNT);
    }

    private findConceptWithWorstOverallScore(concepts: ConceptModel[]): ConceptModel {
        let worstOverallScore = 2; // The overall score value never exceed 2
        let result: ConceptModel = undefined;
        each(concepts, concept => {
            if(concept.overallScore < worstOverallScore) {
                worstOverallScore = concept.overallScore;
                result = concept;
            }
        });
        return result;
    }

    /**
     * Calculate contribution of each concept in concepts set and average of those values
     *
     * @param concepts
     * @returns {number} - average contribution
     */
    private calcContributionOfConcepts(concepts: ConceptModel[]): number {
        let sumContribution  = 0;

        // Calculate contribution value of each concept in concepts
        each(concepts, concept => {
            let coverOfOtherConcepts: ConceptModel[] = [];
            each(concepts, el => {
                if(el !== concept) {
                    coverOfOtherConcepts = union(coverOfOtherConcepts, el.covered);
                }
            });

            let contribution = (difference(concept.covered, coverOfOtherConcepts)).length;
            concept.contribution = contribution;
            sumContribution += contribution;
        });

        return sumContribution/concepts.length;
    }


    /**
     * Calc overall score of all class in set concepts
     * Overall score of each class will be changed according to the set this class is located in
     *
     * @param concepts
     * @returns {number} - average of overall score of each concepts in concepts set
     */
    private calcOverallScoreOfConcepts(concepts: ConceptModel[]): number {
        let sumOverallScore = 0;
        let maxContribution = this.findMaxContribution(concepts);

        each(concepts, concept =>  {
            let overallScore = this.WEIGHT_CO * concept.contribution/maxContribution
                + this.WEIGHT_CR * concept.score;
            concept.overallScore = overallScore;
            sumOverallScore += overallScore;
        });

        if(!sumOverallScore) {

        }
        return sumOverallScore/concepts.length;
    }

    private findMaxContribution(concepts: ConceptModel[]) {
        let maxContribution = 0;
        each(concepts, concept => {
            if(concept.contribution > maxContribution) {
                maxContribution = concept.contribution;
            }
        });
        return maxContribution;
    }

    /**
     * Calc score of all classes
     */
    private calcScoreOfConcepts() {
        each(this.concepts, concept => {
            concept.score = concept.ncValue + concept.density;
        });
    }

    /**
     * Calculate name simplicity value of all classes
     * This method works correctly if each class is an owl classes
     */
    private calcNameSimplicityOfConcepts() {
        each(this.concepts, concept => {
            let name = uri2name(concept.id);
            // Concept is named by owl naming convention
            var numberOfCompound = name.length - name.replace(/[A-Z_]/g, '').length;
            concept.nameSimplicity = 1 - this.NC_CONSTANT * (numberOfCompound -1);
            if(concept.nameSimplicity < 0) {
                concept.nameSimplicity = 0;
            }
        });
    }

    /**
     * Calculate basic level of concepts
     */
    private calcBasicLevelOfConcepts() {
        let max: number = 0;
        each(this.paths, path => {
            // Length of path should >= 3
            if(path.length >= 3) {
                for(let i = 1; i <path.length -1; ++i) {
                    let basicLevel = path[i].basicLevel + 1;
                    path[i].basicLevel = basicLevel;
                    if(basicLevel > max) {
                        max = basicLevel;
                    }
                }
            }
        });
        // Normalize basic level of each concepts
        each(this.concepts, concept => {
            concept.basicLevel = concept.basicLevel/max;
        });
    }

    /**
     * Calculate natural category value of all classes
     */
    private calcNaturalCategoryValueOfConcepts () {
        this.calcNameSimplicityOfConcepts();
        this.calcBasicLevelOfConcepts();
        each(this.concepts, concept => {
            concept.ncValue = this.WEIGHT_BASIC_LEVEL * concept.basicLevel
                + this.WEIGHT_NAME_SIMPLICITY * concept.nameSimplicity;
        });
    }

    /**
     * Calculate global density, local density and density of each classes
     */
    private calcDensityOfConcepts() {
        // Find aGlobalDensity of class and maxAGlobalDensity
        each(this.concepts, concept => {
            let aGlobalDensity: number =  concept.children.length * this.WEIGHT_SUBCLASSES
                + concept.count * this.WEIGHT_INSTANCES
                + concept.propertyCount * this.WEIGHT_PROPERTIES;
            concept.aGlobalDensity = aGlobalDensity;
            if(aGlobalDensity > this.maxAGlobalDensity) {
                this.maxAGlobalDensity = aGlobalDensity;
            }
        });

        // Calc densities
        this.concepts.forEach(concept => {
            // Calc global density
            concept.globalDensity = concept.aGlobalDensity / this.maxAGlobalDensity;
            // Calc local density
            this.calcLocalDensity(concept);
            // Calc density
            concept.density = this.WEIGHT_GLOBAL_DENSITY * concept.globalDensity
                + this.WEIGHT_LOCAL_DENSITY * concept.localDensity;
        });
    }

    /**
     * Calculate local density of given class
     *
     * @param concept
     */
    private calcLocalDensity(concept: ConceptModel) {
        let maxWeightedGlobalDensity = 0;
        let nearestConcepts = this.getNearestConceptsKLevel(2, concept);
        each(nearestConcepts, nearestConcept =>  {
            let weightedGlobalDensity = (1 - (this.RATIO_DISTANCE * Math.abs(concept.level - nearestConcept.level)))
                * nearestConcept.globalDensity;
            if(weightedGlobalDensity > maxWeightedGlobalDensity) {
                maxWeightedGlobalDensity = weightedGlobalDensity;
            }
        });
        concept.localDensity = concept.globalDensity/maxWeightedGlobalDensity
            + this.WEIGHT_GDL * concept.globalDensity;
    }

    /**
     * Get parents and sub concepts of current concept up to k level
     *
     * @param k - number of level
     * @param concept - concept that is covered by
     * @returns {ConceptModel[]}
     */
    private getNearestConceptsKLevel(k: number, concept: ConceptModel) : ConceptModel[]{
        let nearestClasses: ConceptModel[] = [];
        nearestClasses.push(concept);

        let addSubConceptsKLevel = (initLevel: number, concept: ConceptModel, k: number) : ConceptModel[] => {
            let result:ConceptModel[] = [];
            if(concept.level  + 1 - initLevel <= k) {
                each(concept.children, subConcept =>  {
                    result.push(subConcept);
                    let subResult: ConceptModel[] = addSubConceptsKLevel(initLevel, subConcept, k);
                    result = union(result, subResult);
                });
            }
            return result;
        };

        let addSuperConceptsKLevel = (initLevel: number, concept: ConceptModel, k: number): ConceptModel[] => {
            let  result: ConceptModel[] = [];
            if(initLevel - concept.level < k) {
                each(concept.parent, superConcept => {
                    result.push(superConcept);
                    let superResult: ConceptModel[] = addSuperConceptsKLevel(initLevel, superConcept, k);
                    result = union(result, superResult);
                });
            }
            return result;
        };

        let subConceptsKLevel:ConceptModel[] = addSubConceptsKLevel(concept.level, concept, k);
        let superConceptsKLevel: ConceptModel[] = addSuperConceptsKLevel(concept.level, concept, k);
        nearestClasses = union(nearestClasses, subConceptsKLevel, superConceptsKLevel);

        return nearestClasses;
    }

    public unShowConcepts() {
        each(this.concepts, concept =>  {
            concept.presentOnDiagram = false;
        });
    }


    /**
     * Get path from one concept to its super concept
     * @param sourceId - child concept
     * @param targetId - super concept
     * @returns {ConceptModel[]}
     */
    public getIsAPath(sourceId: string, targetId: string) {
        let source: ConceptModel = this.conceptsById[sourceId];
        // create bfs concepts model
        let check: Dictionary<BFSConceptModel> = {};
        check[sourceId] = {id: sourceId, checked: false};
        each(source.allSuperConcepts, parent => {
            let bfsConcept: BFSConceptModel = {id: parent.id, checked: false};
            check[bfsConcept.id] = bfsConcept;
        });

        // BFS
        let queue: ConceptModel[] = [];
        queue.push(source);

        let trace: Dictionary<ConceptModel> = {};
        while(queue.length >0) {
            let u: ConceptModel = queue.shift();
            check[u.id].checked = true;
            if(u.id == targetId) {
                break;
            }
            each(u.parent, parent => {
                if(!check[parent.id].checked) {
                    queue.push(parent);
                    trace[parent.id] = u;
                }
            });
        }

        let result: ConceptModel[] = [];
        let currentId = targetId;
        result.push(this.conceptsById[targetId]);
        while(currentId != sourceId) {
            result.push(trace[currentId]);
            currentId = trace[currentId].id;
        }

        return result;
    }

    public getSubConceptInfo(id: string): string {
        let concept: ConceptModel = this.conceptsById[id];
        if(concept) {
            return '(' + concept.children.length + ',' + concept.indirectSubConcepts.length + ')';
        }
        return '';
    }

    getPropertyById(labelId: string): RichProperty {
        if (!this.propertyLabelById[labelId]) {
            this.propertyLabelById[labelId] = new RichProperty({
                id: labelId,
                label: {values: [{lang: '', text: uri2name(labelId)}]},
            });
            this.propertyLabelFetchingThread.startFetchingThread(labelId).then(propertyIds => {
                if (!this.dataProvider.propertyInfo) { return; }
                if (propertyIds.length === 0) { return; }
                this.dataProvider.propertyInfo({propertyIds}).then(propertyModels => {
                    for (const propertyId in propertyModels) {
                        if (!Object.hasOwnProperty.call(propertyModels, propertyId)) { continue; }
                        const propertyModel = propertyModels[propertyId];
                        if (!this.propertyLabelById[propertyModel.id]) { continue; }
                        this.propertyLabelById[propertyModel.id].set('label', propertyModel.label);
                    }
                });
            });
        }
        return this.propertyLabelById[labelId];
    }

    getClassesById(typeId: string): FatClassModel {
        if (!this.classesById[typeId]) {
            this.classesById[typeId] = new FatClassModel({
                id: typeId,
                label: { values: [{lang: '', text: uri2name(typeId)}] },
                count: 0,
                children: [],
                parent: undefined,
            });
            this.classFetchingThread.startFetchingThread(typeId).then(typeIds => {
                if (typeIds.length > 0) {
                    this.dataProvider.classInfo({classIds: typeIds}).then(classes => {
                        for (const cl of classes) {
                            if (!this.classesById[cl.id]) { continue; }
                            this.classesById[cl.id].set('label', cl.label);
                            this.classesById[cl.id].set('count', cl.count);
                        }
                    });
                }
            });
        }
        return this.classesById[typeId];
    }

    createLinkType(linkTypeId: string): FatLinkType {
        if (this.linkTypes.hasOwnProperty(linkTypeId)) {
            return this.linkTypes[linkTypeId];
        }

        const defaultLabel = {values: [{text: uri2name(linkTypeId), lang: ''}]};
        const fatLinkType = new FatLinkType({
            id: linkTypeId,
            index: this.nextLinkTypeIndex++,
            label: defaultLabel,
            diagram: this,
        });

        this.linkFetchingThread.startFetchingThread(linkTypeId).then(linkTypeIds => {
            if (linkTypeIds.length > 0) {
                this.dataProvider.linkTypesInfo({linkTypeIds}).then(linkTypesInfo => {
                    for (const lt of linkTypesInfo) {
                        if (!this.linkTypes[lt.id]) { continue; }
                        this.linkTypes[lt.id].label = lt.label;
                    }
                });
            }
        });

        this.linkTypes[linkTypeId] = fatLinkType;
        return fatLinkType;
    }

    // Normalize the loaded elements to match model's element standard
    private onElementInfoLoaded(elements: Dictionary<ElementModel>) {
        for (const id of Object.keys(elements)) {
            const element = this.getElement(id);
            if (element) {
                element.template = elements[id];
                // This will cause a rerender in elementLayer
                element.trigger('state:loaded');
            }
        }
    }

    private onLinkInfoLoaded(links: LinkModel[]) {
        this.initBatchCommand();
        for (const linkModel of links) {
            if(linkModel.linkTypeId !== "http://www.w3.org/2002/07/owl#disjointWith") {
                this.createLink(linkModel);
            }
        }
        this.trigger('state:linksInfoCreated');
        this.storeBatchCommand();
    }

    // Create link after loading from db
    createLink(linkModel: LinkModel & {
        suggestedId?: string;
        vertices?: Array<{ x: number; y: number; }>;
    }, options?: IgnoreCommandHistory): Link | undefined {
        const existingLink = this.getLink(linkModel);
        if (existingLink) {
          if (existingLink.layoutOnly) {
            existingLink.set('layoutOnly', false, {ignoreCommandManager: true} as IgnoreCommandHistory);
          }
          return existingLink;
        }
        const {linkTypeId, sourceId, targetId, suggestedId, vertices, directLink} = linkModel;
        const suggestedIdAvailable = Boolean(suggestedId && !this.cells.get(suggestedId));

        // Create link with generation ID
        const link = new Link({
            id: suggestedIdAvailable ? suggestedId : `link_${generateRandomID()}`,
            typeId: linkTypeId,
            source: {id: sourceId},
            target: {id: targetId},
            directLink: directLink,
            vertices,
        });

        if (this.isSourceAndTargetVisible(link) && this.createLinkType(link.typeId).visible) {
            this.registerLink(link);
            this.graph.addCell(link, options);
            return link;
        }
        return undefined;
    }

    private registerLink(link: Link) {
        const typeId = link.typeId;
        if (!this.linksByType.hasOwnProperty(typeId)) {
            this.linksByType[typeId] = [];
        }
        this.linksByType[typeId].push(link);

        if (link.typeIndex === undefined) {
            link.typeIndex = this.createLinkType(typeId).index;
        }
        this.sourceOf(link).links.push(link);
        this.targetOf(link).links.push(link);
    }

    getLink(linkModel: LinkModel): Link | undefined {
        const source = this.getElement(linkModel.sourceId);
        if (!source) { return undefined; }
        const index = findLinkIndex(source.links, linkModel);
        return index >= 0 && source.links[index];
    }

    private removeLinkReferences(linkModel: LinkModel) {
        const source = this.getElement(linkModel.sourceId);
        removeLinkFrom(source && source.links, linkModel);

        const target = this.getElement(linkModel.targetId);
        removeLinkFrom(target && target.links, linkModel);

        const linksOfType = this.linksByType[linkModel.linkTypeId];
        removeLinkFrom(linksOfType, linkModel);
    }
}

export default DiagramModel;

export interface ClassTreeElement {
    id: string;
    label: { values: LocalizedString[] };
    count: number;
    children: ClassTreeElement[];
    a_attr?: { href: string };
    parent: string;
}

export interface LinkTypeOptions {
    id: string;
    visible: boolean;
    showLabel?: boolean;
}

function placeholderTemplateFromIri(iri: string): ElementModel {
    return {
        id: iri,
        types: [],
        label: {values: [{lang: '', text: uri2name(iri)}]},
        properties: {},
    };
}

function removeLinkFrom(links: Link[], model: LinkModel) {
    if (!links) { return; }
    const index = findLinkIndex(links, model);
    links.splice(index, 1);
}

function findLinkIndex(haystack: Link[], needle: LinkModel) {
    const {sourceId, targetId, linkTypeId} = needle;
    for (let i = 0; i < haystack.length; i++) {
        const link = haystack[i];
        if (link.sourceId === sourceId &&
            link.targetId === targetId &&
            link.typeId === linkTypeId
        ) {
            return i;
        }
    }
    return -1;
}

/** Generates random 16-digit hexadecimal string. */
function generateRandomID() {
    function randomHalfDigits() {
        return Math.floor((1 + Math.random()) * 0x100000000)
            .toString(16).substring(1);
    }
    // generate by half because of restricted numerical precision
    return randomHalfDigits() + randomHalfDigits();
}

export function uri2name(uri: string): string {
    const hashIndex = uri.lastIndexOf('#');
    if (hashIndex !== -1 && hashIndex !== uri.length - 1) {
        return uri.substring(hashIndex + 1);
    }
    const lastPartStart = uri.lastIndexOf('/');
    if (lastPartStart !== -1 && lastPartStart !== uri.length - 1) {
        return uri.substring(lastPartStart + 1);
    }
    return uri;
}

export function chooseLocalizedText(texts: LocalizedString[], language: string): LocalizedString {
    if (texts.length === 0) { return null; }
    // undefined if default language string isn't present
    let defaultLanguageValue: LocalizedString;
    for (const text of texts) {
        if (text.lang === language) {
            return text;
        } else if (text.lang === '') {
            defaultLanguageValue = text;
        }
    }
    return typeof defaultLanguageValue === 'undefined' ? texts[0] : defaultLanguageValue;
}
