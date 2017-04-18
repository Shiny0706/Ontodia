import * as Backbone from 'backbone';
import { each, size, values, keyBy, defaults, uniqueId, sortBy, take, takeRight, difference, union, uniqBy} from 'lodash';
import * as joint from 'jointjs';

import {
    Dictionary, LocalizedString, LinkType, ClassModel, ElementModel, LinkModel, PropertyCount,
} from '../data/model';
import { DataProvider } from '../data/provider';

import { LayoutData, LayoutElement, normalizeImportedCell, cleanExportedLayout } from './layoutData';
import { Element, Link, FatLinkType, FatClassModel, RichProperty } from './elements';
import { DataFetchingThread } from './dataFetchingThread';
import Config from '../../../stardogConfig';
import {getConceptAndConceptRepresentationOfResource} from '../data/sparql/provider';
import max = require("lodash/max");

export type IgnoreCommandHistory = { ignoreCommandManager?: boolean };
export type PreventLinksLoading = { preventLoading?: boolean; };


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
    pureClassTree: ClassTreeElement[];

    private classesById: Dictionary<FatClassModel> = {};
    private pureClassesById: Dictionary<FatClassModel> = {};
    private fatClasses: FatClassModel[] = [];
    private maxLevel: number;
    private nodesByLevel: Dictionary<FatClassModel[]> = {};
    private propertyLabelById: Dictionary<RichProperty> = {};

    private nextLinkTypeIndex = 0;
    private linkTypes: Dictionary<FatLinkType>;

    private linksByType: Dictionary<Link[]> = {};

    private classFetchingThread: DataFetchingThread;
    private linkFetchingThread: DataFetchingThread;
    private propertyLabelFetchingThread: DataFetchingThread;

    private keyConcepts: FatClassModel[];

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
                const {typeId, sourceId, targetId} = cell;
                this.removeLinkReferences({linkTypeId: typeId, sourceId, targetId});
            }
        });
    }

    //this function has never been called
    createNewDiagram(dataProvider: DataProvider): Promise<void> {
        this.dataProvider = dataProvider;
        this.trigger('state:beginLoad');

        return Promise.all<any>([
            this.dataProvider.classTree(),
            this.dataProvider.linkTypes(),
        ]).then(([[classTree, pureClassTree], linkTypes]: [[ClassModel[], ClassModel[]], LinkType[]]) => {
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

        return Promise.all<ClassModel[], LinkType[], PropertyCount[]>([
            //run query against database to generate class tree and link types
            this.dataProvider.classTree(),
            this.dataProvider.linkTypes(),
            this.dataProvider.propertyCountOfClasses(),
        ]).then(([[classTree, pureClassTree], linkTypes, propertyCount]) => {
            this.setClassTree(classTree);
            this.setPureClassTree(pureClassTree, propertyCount);
            this.keyConcepts = this.extractConcepts(16);
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
            this.trigger('state:endLoad', null, err.errorKind, err.message);
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

    setPureClassTree(rootPureClassesTree: ClassModel[], propertyCount: PropertyCount[]) {

        this.pureClassTree = rootPureClassesTree;
        const addPureClass = (cl: ClassTreeElement, level: number) => {
            let classModel = new FatClassModel(cl);
            classModel.set('level', level);

            this.fatClasses.push(classModel);

            this.pureClassesById[cl.id] = classModel;

            if(this.nodesByLevel[level] === undefined) {
                this.nodesByLevel[level] = [];
            }
            this.nodesByLevel[level].push(classModel);

            if(level > this.maxLevel) {
                this.maxLevel = level;
            }

            if(cl.children.length > 0) {
                let childrenLevel =  level + 1;
                let basicLevel = 0;
                each(cl.children, (el) => {
                    basicLevel += addPureClass(el, childrenLevel);
                    let addedChild:FatClassModel = this.pureClassesById[el.id];
                    classModel.directSubClasses.push(addedChild);
                    classModel.allSubClasses.push(addedChild);
                    each(addedChild.allSubClasses, childOfChild => {
                        classModel.allSubClasses.push(childOfChild);
                        classModel.indirectSubClasses.push(childOfChild);
                    });
                });
                classModel.basicLevel = basicLevel;
                return basicLevel;
            } else {
                classModel.basicLevel = 0;
                return 1;
            }
        };

        this.maxLevel = 1;
        each(rootPureClassesTree, (el) => {
            addPureClass(el, 1);
        });

        each(propertyCount, (item) =>  {
            if(this.pureClassesById[item.id]) {
                this.pureClassesById[item.id].propertyCount = item.count;
            }
        });

    }

    getPureClassesById() {
        return this.pureClassesById;
    }

    getPureClassTree() : ClassTreeElement[]{
        return this.pureClassTree;
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

    // Load data of ui elements: element's id, label, types, properties(object properties, data properties and their values)
    requestElementData(elements: Element[]) {
        return this.dataProvider.elementInfo({elementIds: elements.map(e => e.id)})
            .then(models => this.onElementInfoLoaded(models))
            .catch(err => {
                console.error(err);
                return Promise.reject(err);
            });
    }

    // Load links that related to all elements in diagram
    requestLinksOfType(linkTypeIds?: string[]) {
        let linkTypes = linkTypeIds;
        if (!linkTypes) {
            linkTypeIds = values(this.linkTypes).map(type => type.id);
        }
        return this.dataProvider.linksInfo({
            elementIds: this.graph.getElements().map(element => element.id),
            linkTypeIds: linkTypeIds,
        }).then(links => this.onLinkInfoLoaded(links))
        .catch(err => {
            console.error(err);
            return Promise.reject(err);
        });
    }

    private getPureClassById(id: string) {
        return this.pureClassesById[id];
    }

    public createVirtualLinksBetweenKeyConcepts() {
        let root = this.getPureClassById('http://www.w3.org/2002/07/owl#Thing');
        let kcMap:Dictionary<FatClassModel> = {};
        each(this.keyConcepts, concept => {
            kcMap[concept.id] = concept;
        });

        // Init current node list
        let currentLevelNodes: FatClassModel[] = [root];
        delete kcMap[root.id];

        let links: LinkModel[] = [];
        let level = 0;
        while(currentLevelNodes.length > 0) {
            ++level;
            let nextLevelNodes: FatClassModel[] = [];
            each(currentLevelNodes, node => {
                each(node.directSubClasses, subClass =>  {
                    if(kcMap[subClass.id]) {
                        // add direct is-a link then remove subClass from kcMap
                        node.subKeyConcepts.push(subClass);
                        nextLevelNodes.push(subClass);
                        let link = {
                            linkTypeId: 'http://www.w3.org/2000/01/rdf-schema#subClassOf',
                            sourceId: subClass.id,
                            targetId: node.id
                        };
                        links.push(link);
                    }
                });

                each(node.indirectSubClasses, indirectSubClass =>  {
                    if(kcMap[indirectSubClass.id]) {
                        let found = false;
                        let superClasses = indirectSubClass.allSuperClasses;
                        for(let i = 0; i < superClasses.length; ++i){
                            if(kcMap[superClasses[i].id]) {
                                found = true;
                                break;
                            }
                        }
                        if(!found) {
                            // add indirect is-a link then remove indirectSubClass from kcMap
                            node.subKeyConcepts.push(indirectSubClass);
                            nextLevelNodes.push(indirectSubClass);
                            let link = {
                                linkTypeId: 'http://www.w3.org/2000/01/rdf-schema#subClassOf',
                                sourceId: subClass.id,
                                targetId: node.id
                            }
                            link.push(link);
                            console.log('add an indirect link');
                        }
                    }
                });

            });
            each(nextLevelNodes, nextLevelNode => {
               delete kcMap[nextLevelNode.id];
            });
            currentLevelNodes = nextLevelNodes;
        }
        this.onLinkInfoLoaded(links);
    }

    private k = 15;
    private ncConstant = 0.3;
    private weightBasicLevel:number = 0.66;
    private weightNameSimplicity: number = 0.33;
    private weightLocalDensity = 0.32;
    private weightGlobalDensity = 0.08;
    private weightSubClasses : number = 0.8;
    private weightProperties : number = 0.1;
    private weightInstances: number = 0.1;
    private weightCO: number = 0.6;
    private weightCR: number = 0.4;
    private maxAGlobalDensity = 0;
    private maxContribution: number = 0;
    private maxOverallScore: number = 0;

    /**
     * Extract key concepts by using algorithm Key Concepts Extraction
     *
     * @param n - number of key concepts to extract
     * @return - key concepts
     */
    public extractConcepts(n: number): FatClassModel[]{
        this.calcAllDensity();
        this.calcAllScores();
        this.calcAllNameSimplicity();
        this.calcAllNaturalCategoryValue();
        this.calcAllScores();
        this.fatClasses = sortBy(this.fatClasses,
                [function(classModel) {
                    // This is a tricky thing, sortBy yields a result with ascending ...
                    return -classModel.score;
                }
             ]);
        let kBestClasses: FatClassModel[] = take(this.fatClasses, this.k);
        let remainClasses: FatClassModel[] = takeRight(this.fatClasses, this.fatClasses.length - this.k);
        let secondaryBestClasses: FatClassModel[] = take (remainClasses, n-this.k);
        let nBestClasses: FatClassModel[] = take(this.fatClasses, n);
        let remainClassesAfterTakeN: FatClassModel[] =  takeRight(this.fatClasses, this.fatClasses.length -n);
        if(secondaryBestClasses.length == 0) {
            return kBestClasses;
        }

        this.findCoveredOfClasses();

        let loop = true;
        let newClassesSet = nBestClasses;
        let counter = 0;
        while(loop) {
            counter++;
            // Calc contribution of all classes in nBestClasses
            let avgContribution = this.calcAvgContribution(newClassesSet);

            // Calc overallScore of all classes in nBestClasses
            let avgOverallScore = this.calcAvgOverallScore(newClassesSet);

            // Find class with the worst value of overallScore
            let worstScore: number = this.maxOverallScore;
            let worstScoreClass: FatClassModel = undefined;
            each(newClassesSet, classModel =>  {
                if(classModel.overallScore < worstScore) {
                    worstScore = classModel.overallScore;
                    worstScoreClass = classModel;
                }
            });

            let excludedWorstScoreClassSet = difference(nBestClasses, [worstScoreClass]);
            each(remainClassesAfterTakeN, remainClass => {
                newClassesSet = union(excludedWorstScoreClassSet, [remainClass]);

                // Calc contribution of all classes in newClassesSet
                let avgContribution1 = this.calcAvgContribution(newClassesSet);

                // Calc overallScore of all classes in newClassesSet
                let avgOverallScore1 = this.calcAvgOverallScore(newClassesSet);

                if(avgContribution1 >= avgContribution && avgOverallScore1 >= avgOverallScore) {
                    loop = true;
                } else {
                    loop = false;
                }
            });
        }

        console.log("Number of loop: " + counter);
        return newClassesSet;
    }

    /**
     * Return extracted concepts
     */
    public getKeyConcepts(): FatClassModel[] {
        return this.keyConcepts;
    }

    /**
     * Cal average contribution of each classes in set fatClasses
     *
     * @param fatClasses
     * @returns {number}
     */
    // TODO: check for correction of this function
    private calcAvgContribution(fatClasses: FatClassModel[]): number {
        let sumContribution  = 0;
        this.maxContribution = 0;
        // Calculate contribution value of class in set fatClasses
        each(fatClasses, classModel => {
            let excludedCurrentClass = difference(fatClasses, [classModel]);
            let classes = [];
            each(excludedCurrentClass, el => {
                classes = union(classes, el.covered);
            });
            classes = uniqBy(classes, function(classModel) {
                return classModel.id;
            });
            let contribution = this.findContribution(classModel.covered, classes);
            classModel.contribution = contribution;
            sumContribution += contribution;
            if(contribution > this.maxContribution) {
                this.maxContribution = contribution;
            }
        });

        return sumContribution/fatClasses.length;
    }

    /**
     * Find contribution of each class in firstSet
     * @param firstSet
     * @param secondSet
     * @returns {number}
     */
    private findContribution(firstSet: FatClassModel[], secondSet: FatClassModel[]) {
        let contribution = 0;
        each(firstSet, classModel =>  {
            if(secondSet.indexOf(classModel) >= 0) {
                contribution ++;
            }
        });
        return contribution;
    }

    /**
     * Calc overall score of all class in set fatClasses
     * Overall score of each class will be changed according to the set this class is located in
     *
     * @param fatClasses
     * @returns {number}
     */
    private calcAvgOverallScore(fatClasses: FatClassModel[]): number {
        let sumOverallScore = 0;
        this.maxOverallScore = 0;
        each(fatClasses, classModel =>  {
            let overallScore = this.weightCO * classModel.contribution/this.maxContribution + this.weightCR * classModel.score;
            classModel.overallScore = overallScore;
            sumOverallScore += overallScore;
            if(overallScore > this.maxOverallScore) {
                this.maxOverallScore = overallScore;
            }
        });
        return sumOverallScore/fatClasses.length;
    }

    /**
     * Union all superclasses and subclasses into covered
     */
    // TODO: consider removing this method, assign value of covered in setPureClassTree
    private findCoveredOfClasses() {
        each(this.fatClasses, classModel => {
            this.findAllSuperClasses(classModel);
            classModel.covered = union(classModel.allSubClasses, [classModel], classModel.allSuperClasses);
        });
    }

    /**
     * Find all super classes of given classes
     * @param classModel
     */
    // TODO: remove this method cuz we have field allSuperclasses in FatClassModel
    private findAllSuperClasses(classModel: FatClassModel) {
        let parentId = classModel.model.parent;
        while(parentId) {
            let parentClassModel = this.pureClassesById[parentId];
            classModel.allSuperClasses.push(parentClassModel);
            parentId = parentClassModel.model.parent;
        }
    }

    /**
     * Calc score of all classes
     */
    private calcAllScores() {
        each(this.fatClasses, classModel => {
            classModel.score = classModel.ncValue + classModel.density;
        });
    }

    /**
     * Calculate name simplicity value of all classes
     * This method works correctly if each class is an owl classes
     */
    private calcAllNameSimplicity() {
        each(this.fatClasses, classModel => {
            let name = uri2name(classModel.id);
            // Concept is named by owl naming convention
            var numberOfCompound = name.length - name.replace(/[A-Z]/g, '').length;
            classModel.nameSimplicity = 1 - this.ncConstant * (numberOfCompound -1);
        });
    }

    /**
     * Calculate natural category value of all classes
     */
    private calcAllNaturalCategoryValue () {
        each(this.fatClasses, classModel => {
            let ncValue = this.weightBasicLevel * classModel.basicLevel;
                + this.weightNameSimplicity * classModel.nameSimplicity;
            classModel.ncValue = ncValue;
        });
    }

    /**
     * Calculate global density, local density and density of each classes
     */
    private calcAllDensity() {
        // Find aGlobalDensity of class and maxAGlobalDensity
        each(this.fatClasses, classModel => {
            let aGlobalDensity: number =  classModel.model.children.length * this.weightSubClasses
                + classModel.model.count * this.weightInstances
                + classModel.propertyCount * this.weightProperties;
            classModel.aGlobalDensity = aGlobalDensity;
            if(aGlobalDensity > this.maxAGlobalDensity) {
                this.maxAGlobalDensity = aGlobalDensity;
            }
        });

        // Calc densities
        this.fatClasses.forEach(classModel => {
            // Calc global density
            classModel.globalDensity = classModel.aGlobalDensity / this.maxAGlobalDensity;
            // Calc local density
            this.calcLocalDensity(classModel);
            // Calc density
            classModel.density = this.weightGlobalDensity * classModel.globalDensity
                + this.weightLocalDensity * classModel.localDensity;
        });
    }

    /**
     * Calculate local density of current class
     *
     * @param classModel
     */
    // TODO: reveal the local density formula
    private calcLocalDensity(classModel: FatClassModel) {
        let maxGlobalDensityNearestClasses = 0;
        let nearestClasses = this.getNearestClassesKLevel(2, classModel);
        each(nearestClasses, nearestClass =>  {
            if(nearestClass.globalDensity > maxGlobalDensityNearestClasses) {
                maxGlobalDensityNearestClasses = nearestClass.globalDensity;
            }
        });

        classModel.localDensity = classModel.globalDensity/maxGlobalDensityNearestClasses;
    }

    /**
     * Get superclasses and subclasses of current class up to k level
     *
     * @param k - number of level
     * @param classModel - class that is covered by
     * @returns {FatClassModel[]}
     */
    private getNearestClassesKLevel(k: number, classModel: FatClassModel) : FatClassModel[]{
        let nearestClasses: FatClassModel[] = [];
        nearestClasses.push(classModel);
        let current = classModel;
        for( let i = 0; i < k; ++i) {
            let parent = this.getParent(current);
            if(parent) {
                nearestClasses.push(parent);
                current = parent;
            }
        }

        // TODO: add more than one level
        let childFatClasses = this.getChildFatClass(classModel);
        each(childFatClasses, child => {
            nearestClasses.push(child);
        });
        return nearestClasses;
    }

    /**
     * Get direct subclasses of current class
     * @param classModel
     * @returns {FatClassModel[]}
     */
    // TODO: consider removing this function cuz we have directSubclasses in FatClassModel
    private getChildFatClass(classModel: FatClassModel) : FatClassModel[]{
        let childFatClasses: FatClassModel[] = [];
        let children = classModel.model.children;
        if(children.length > 0) {
            each(children, child =>  {
                childFatClasses.push(child.id);
            });
        }
        return childFatClasses;
    }

    /**
     * Get superclass of given class
     *
     * @param classModel
     * @returns {FatClassModel}
     */
    private getParent(classModel: FatClassModel): FatClassModel {
        let parentId = classModel.model.parent;
        let parent: FatClassModel = undefined;
        if(parentId) {
            parent = this.pureClassesById[parentId];
        }
        return parent;
    }

    /**
     * This method serves in visualizing ontology cognitive-information space
     */
    requestVirtualLinksBetweenConceptsAndResources() {
        let endpoint = Config.HOSTNAME + ':' + Config.PORT +'/' + Config.DB + '/query';
        getConceptAndConceptRepresentationOfResource(endpoint)
            .then(links => {
                this.onLinkInfoLoaded(links);
            });
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
            this.createLink(linkModel);
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
        const {linkTypeId, sourceId, targetId, suggestedId, vertices} = linkModel;
        const suggestedIdAvailable = Boolean(suggestedId && !this.cells.get(suggestedId));

        // Create link with generation ID
        const link = new Link({
            id: suggestedIdAvailable ? suggestedId : `link_${generateRandomID()}`,
            typeId: linkTypeId,
            source: {id: sourceId},
            target: {id: targetId},
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
