import {each} from 'lodash';
import {
    RdfLiteral, SparqlResponse, ClassBinding, ElementBinding, LinkBinding,
    ElementImageBinding, LinkTypeBinding, LinkTypeInfoBinding, PropertyBinding, ConceptBinding,
} from './sparqlModels';
import {
    Dictionary, LocalizedString, LinkType, ClassModel, ElementModel, LinkModel, Property, PropertyModel, ConceptModel, PropertyCount
} from '../model';
import union = require("lodash/union");

const THING_URI = 'http://www.w3.org/2002/07/owl#Thing';
const LABEL_URI = 'http://www.w3.org/2000/01/rdf-schema#label';
const NAME_INDIVIDUAL_URI = "http://www.w3.org/2002/07/owl#NamedIndividual";
const CLASS_URI = "http://www.w3.org/2002/07/owl#Class";
const DATA_TYPE_PROPERTY_URI = "http://www.w3.org/2002/07/owl#DatatypeProperty";
const FUNCTIONAL_PROPERTY_URI = "http://www.w3.org/2002/07/owl#FunctionalProperty";
const OBJECT_PROPERTY_URI = "http://www.w3.org/2002/07/owl#ObjectProperty";
const TRANSITIVE_PROPERTY_URI = "http://www.w3.org/2002/07/owl#TransitiveProperty";
const SYMMETRIC_PROPERTY_URI = "http://www.w3.org/2002/07/owl#SymmetricProperty";
const ANNOTATION_PROPERTY_URI = "http://www.w3.org/2002/07/owl#AnnotationProperty";
const DISJOINT_CLASSES_URI = "http://www.w3.org/2002/07/owl#DisjointClasses";
const ALL_DIFFERENT_URI = "http://www.w3.org/2002/07/owl#AllDifferent";
const RESTRICTION_URI = "http://www.w3.org/2002/07/owl#Ontology";
const ONTOLOGY_URI = "http://www.w3.org/2002/07/owl#Ontology";

const PRIMITIVE_TYPE = [THING_URI, LABEL_URI, NAME_INDIVIDUAL_URI, CLASS_URI,
    DATA_TYPE_PROPERTY_URI, FUNCTIONAL_PROPERTY_URI, OBJECT_PROPERTY_URI,
    TRANSITIVE_PROPERTY_URI, SYMMETRIC_PROPERTY_URI, ANNOTATION_PROPERTY_URI,
    DISJOINT_CLASSES_URI, ALL_DIFFERENT_URI, ONTOLOGY_URI, RESTRICTION_URI];

export function getClassTree(response: SparqlResponse<ClassBinding>): [ClassModel[], ConceptModel] {
    const sNodes = response.results.bindings;
    const tree: ClassModel[] = [];
    const createdTreeNodes: Dictionary<ClassModel> = {};
    const tempNodes: Dictionary<ClassModel> = {};

    for (const sNode of sNodes) {
        const sNodeId: string = sNode.class.value;
        if (createdTreeNodes[sNodeId]) {
            if (sNode.label) {
                const label = createdTreeNodes[sNodeId].label;
                if (label.values.length === 1 && !label.values[0].lang) {
                    label.values = [];
                }
                label.values.push(getLocalizedString(sNode.label));
            }
            if (sNode.instcount && createdTreeNodes[sNodeId].count === 0) {
                createdTreeNodes[sNodeId].count = getInstCount(sNode.instcount);
            }
        } else {
            let newNode = getClassModel(sNode);
            createdTreeNodes[sNodeId] = newNode;
            if (sNode.parent) {
                // Put parent to tempNodes if it doesn't present in tempNodes
                newNode.parent = sNode.parent.value;

                const sParentNodeId: string = sNode.parent.value;
                let parentNode: ClassModel;

                // if we put the parent node in first time we create it, 
                // then we miss the count value
                // That's why we put the temp parent node in another list in first time
                if (!createdTreeNodes[sParentNodeId]) {
                    if (!tempNodes[sParentNodeId]) {
                        parentNode = getClassModel({ class: sNode.parent });
                    } else {
                        parentNode = tempNodes[sParentNodeId];
                    }
                    tempNodes[sParentNodeId]  = parentNode;
                } else {
                    parentNode = createdTreeNodes[sParentNodeId];
                }

                parentNode.children.push(newNode);
                parentNode.count += newNode.count;
            } else {
                tree.push(newNode);
                if (tempNodes[sNodeId]) {
                    newNode.count += tempNodes[sNodeId].count;
                    newNode.children = tempNodes[sNodeId].children;
                }
            }
        }
    }

    each(tempNodes, tempNode => {
        let createdNode = createdTreeNodes[tempNode.id];
        each(tempNode.children, childOfTemp => {
            if(createdNode.children.indexOf(childOfTemp) < 0) {
                createdNode.children.push(childOfTemp);
            }
        });
    });

    let pureClassTree: ClassModel[] = [];
    each(tree, classModel => {
        if(PRIMITIVE_TYPE.indexOf(classModel.id) < 0) {
            pureClassTree.push(classModel);
        }
    });

    let thingNode = createdTreeNodes[THING_URI];
    if (!thingNode) {
        thingNode = {
            id: THING_URI,
            children: [],
            label: { values: [getLocalizedString(undefined, THING_URI)] },
            count: 0,
        };
        tree.push(thingNode);
    }

    let rootClass: ClassModel;
    if(pureClassTree.length > 1) {
        pureClassTree.forEach(function(element) {
            element.parent = THING_URI;
            thingNode.children.push(element);
        });
        rootClass = thingNode;
    } else {
        rootClass = pureClassTree[0];
    }

    let rootConcept: ConceptModel = getConceptTree(rootClass);

    updateConceptTree(rootConcept);

    return [tree, rootConcept];
}
/**
 * Build concept tree from class tree
 * @param rootClass
 * @returns {ConceptModel} - root concept
 */
function getConceptTree(rootClass: ClassModel): ConceptModel {
    // Create root concept
    let rootConcept: ConceptModel = getConceptFromClassModel(rootClass);

    let addConcept = (classModel: ClassModel, conceptModel: ConceptModel) => {
        each(classModel.children, childClass => {
            if(PRIMITIVE_TYPE.indexOf(childClass.id) < 0) {
                let childConcept: ConceptModel = getConceptFromClassModel(childClass);
                conceptModel.children.push(childConcept);
                childConcept.parent.push(conceptModel);
                addConcept(childClass, childConcept);
            }
        });
    };

    addConcept(rootClass, rootConcept);

    return rootConcept;
}

/**
 * Update created concept tree with adding covered, direct children, indirect children, super concepts ...
 *
 * @param rootConcept
 */
function updateConceptTree(rootConcept: ConceptModel) {
    let conceptsById: Dictionary<ConceptModel> = {};
    const addSubConcept = (concept: ConceptModel, level: number) => {
        concept.level = level;

        // Update dictionary conceptsById
        conceptsById[concept.id] = concept;

        concept.allSubConcepts = concept.allSubConcepts.concat(concept.children);

        if(concept.children.length > 0) {
            let childLevel = level + 1;
            each(concept.children, child => {
                addSubConcept(child, childLevel);
                concept.allSubConcepts = concept.allSubConcepts.concat(child.allSubConcepts);
                concept.indirectSubConcepts = concept.indirectSubConcepts.concat(child.allSubConcepts);
            });
        }
    };

    addSubConcept(rootConcept, 1);

    let addSuperConcepts = (concept: ConceptModel)  => {
        // Add super concepts
        each(concept.parent, parent => {
            concept.allSuperConcepts.push(parent);
            concept.allSuperConcepts = concept.allSuperConcepts.concat(parent.allSuperConcepts);
        });

        // Update covered
        concept.covered = union(concept.allSuperConcepts, concept.allSubConcepts, [concept]);

        each(concept.children, child => {
            addSuperConcepts(child);
        });
    };

    // Add super concept each concept in tree, then update covered
    // This will take into account situation when concept has more than one super concepts
    addSuperConcepts(rootConcept);

}

function getConceptFromClassModel(classModel: ClassModel): ConceptModel {
    let concept = {
        id: classModel.id,
        children: [],
        label: classModel.label,
        count: classModel.count,
        parent: [],
        aGlobalDensity: 0,
        globalDensity: 0,
        localDensity: 0,
        density: 0,
        contribution: 0,
        nameSimplicity: 0,
        basicLevel: 0,
        ncValue: 0,
        propertyCount: 0,
        score: 0,
        overallScore: 0,
        covered: [],
        allSuperConcepts: [],
        allSubConcepts: [],
        indirectSubConcepts: [],
        subKeyConcepts: [],
        presentOnDiagram: false,
    };
    return concept;
}

export function getInstanceConceptsTree(response: SparqlResponse<ConceptBinding>) : ConceptModel{
    const sNodes = response.results.bindings;
    const createdTreeNodes: Dictionary<ConceptModel> = {};

    for (const sNode of sNodes) {
        const sNodeId: string = sNode.concept.value;

        if(!createdTreeNodes[sNodeId]) {
            createdTreeNodes[sNodeId] = getConceptModel({id: sNode.concept.value, label: sNode.label});
        }
        if(sNode.parent) {
            const parentNodeId: string = sNode.parent.value;
            let parentNode: ConceptModel;
            if(!createdTreeNodes[parentNodeId]) {
                parentNode = getConceptModel({id: sNode.parent.value, label: sNode.parentLabel});
                createdTreeNodes[parentNodeId] = parentNode;
            } else {
                parentNode = createdTreeNodes[parentNodeId];
            }

            parentNode.children.push(createdTreeNodes[sNodeId]);
            createdTreeNodes[sNodeId].parent.push(parentNode);
        }
    };

    let rootConcept = getRootOfConceptsTree(createdTreeNodes);

    updateConceptTree(rootConcept);

    return rootConcept;
}

export function getReverseInstanceConceptsTree(response: SparqlResponse<ConceptBinding>) : ConceptModel{
    const sNodes = response.results.bindings;
    const createdTreeNodes: Dictionary<ConceptModel> = {};

    for (const sNode of sNodes) {
        const sNodeId: string = sNode.concept.value;

        // Add node to tree if node hasn't been added
        if(!createdTreeNodes[sNodeId]) {
            // Create new node
            createdTreeNodes[sNodeId] = getConceptModel({id: sNode.concept.value, label: sNode.label});
        }
        if(sNode.child) {
            const childNodeId: string = sNode.child.value;
            let childNode: ConceptModel;
            if(!createdTreeNodes[childNodeId]) {
                childNode = getConceptModel({id: sNode.child.value, label: sNode.childLabel});
                createdTreeNodes[childNodeId] = childNode;
            } else {
                childNode = createdTreeNodes[childNodeId];
            }

            childNode.parent.push(createdTreeNodes[sNodeId]);
            createdTreeNodes[sNodeId].children.push(childNode);
        }
    };

    let rootConcept = getRootOfConceptsTree(createdTreeNodes);

    updateConceptTree(rootConcept);

    return rootConcept;
}
/**
 * Get root of concept tree from created tree nodes, or create one with uri = THING_URI if root does not exist
 * @param createdTreeNodes
 * @returns {ConceptModel}
 */
function getRootOfConceptsTree(createdTreeNodes: Dictionary<ConceptModel>) {
    let conceptsTree: ConceptModel[] = [];
    each(createdTreeNodes, node => {
        if(node.parent.length == 0) {
            conceptsTree.push(node);
        }
    });

    if(conceptsTree.length > 1) {
        let thingConcept = getConceptModel({id: THING_URI, label: undefined});
        each(conceptsTree, concept => {
            thingConcept.children.push(concept);
            concept.parent.push(thingConcept);
        });
        conceptsTree = [thingConcept];
    }

    return conceptsTree[0];
}

/**
 * Get concept model from id and label
 * @param params
 * @returns ConceptModel
 * */
function getConceptModel(params: {id: string, label: RdfLiteral}) : ConceptModel{
    let values: LocalizedString[] = [];
    if(params.label) {
        values.push(getLocalizedString(params.label, params.id));
    }
    let result = {
        id: params.id,
        children: [],
        label: {values: values},
        count: 0,
        parent: [],
        aGlobalDensity: 0,
        globalDensity: 0,
        localDensity: 0,
        density: 0,
        contribution: 0,
        nameSimplicity: 0,
        basicLevel: 0,
        ncValue: 0,
        propertyCount: 0,
        score: 0,
        overallScore: 0,
        covered: [],
        allSuperConcepts: [],
        allSubConcepts: [],
        indirectSubConcepts: [],
        subKeyConcepts: [],
        presentOnDiagram: false,
    }

    return result;
}

export function getClassInfo(response: SparqlResponse<ClassBinding>): ClassModel[] {
    const classes: { [id: string]: ClassModel } = {};
    for (const binding of response.results.bindings) {
        if (!binding.class) { continue; }
        const id = binding.class.value;
        const model = classes[id];
        if (model) {
            const newLabel = getLocalizedString(binding.label);
            if (!model.label.values.some(label => isLocalizedEqual(label, newLabel))) {
                model.label.values.push(newLabel);
            }
            const instanceCount = getInstCount(binding.instcount);
            if (!isNaN(instanceCount)) {
                model.count =  Math.max(model.count, instanceCount);
            }
        } else {
            const label = getLocalizedString(binding.label);
            classes[id] = {
                id,
                children: [],
                label: {values: label ? [label] : []},
                count: getInstCount(binding.instcount),
            };
        }
    }

    const classesList: ClassModel[] = [];
    for (const id in classes) {
        if (!classes.hasOwnProperty(id)) { continue; }
        const model = classes[id];
        if (model.label.values.length === 0) {
            model.label.values.push(getLocalizedString(undefined, id));
        }
        classesList.push(model);
    }

    return classesList;
}

export function getPropertyInfo(response: SparqlResponse<PropertyBinding>): Dictionary<PropertyModel> {
    const models: Dictionary<PropertyModel> = {};
    for (const sProp of response.results.bindings) {
        const model = getPropertyModel(sProp);
        models[model.id] = model;
    }
    return models;
}

export function getLinkTypes(response: SparqlResponse<LinkTypeBinding>): LinkType[] {
    const sInst = response.results.bindings;
    const linkTypes: LinkType[] = [];
    const instancesMap: Dictionary<LinkType> = {};

    for (const sLink of sInst) {
        let sInstTypeId: string = sLink.link.value;

        if (instancesMap[sInstTypeId]) {
            if (sLink.label) {
                const label = instancesMap[sInstTypeId].label;
                if (label.values.length === 1 && !label.values[0].lang) {
                    label.values = [];
                }
                label.values.push(getLocalizedString(sLink.label));
            }
            if (sLink.instcount) {
                instancesMap[sInstTypeId].count = getInstCount(sLink.instcount);
            }
        } else {
            instancesMap[sInstTypeId] = getLinkType(sLink);
            linkTypes.push(instancesMap[sInstTypeId]);
        }

    };
    return linkTypes;
}

export function getElementsInfo(response: SparqlResponse<ElementBinding>, ids: string[]): Dictionary<ElementModel> {
    const sInstances = response.results.bindings;
    const instancesMap: Dictionary<ElementModel> = {};

    for (const sInst of sInstances) {
        let sInstTypeId: string = sInst.inst.value;

        if (instancesMap[sInstTypeId]) {
            enrichElement(instancesMap[sInst.inst.value], sInst);
        } else {
            instancesMap[sInstTypeId] = getElementInfo(sInst);
        }
    };

    const proccesedIds = Object.keys(instancesMap);
    for (const id of ids) {
        if (proccesedIds.indexOf(id) === -1) {
            instancesMap[id] = {
                id: id,
                label: { values: [getLocalizedString(undefined, id)] },
                types: [THING_URI],
                properties: {},
            };
        }
    };

    return instancesMap;
}

export function getEnrichedElementsInfo(
    response: SparqlResponse<ElementImageBinding>,
    elementsInfo: Dictionary<ElementModel>
): Dictionary<ElementModel> {
    const respElements = response.results.bindings;
    for (const respEl of respElements) {
        const elementInfo = elementsInfo[respEl.inst.value];
        if (elementInfo) {
            elementInfo.image = respEl.image.value;
        }
    }
    return elementsInfo;
}

export function getLinkTypesInfo(response: SparqlResponse<LinkTypeInfoBinding>): LinkType[] {
    const sparqlLinkTypes = response.results.bindings;
    return sparqlLinkTypes.map((sLinkType: LinkTypeInfoBinding) => getLinkTypeInfo(sLinkType));
}

export function getLinksInfo(response: SparqlResponse<LinkBinding>): LinkModel[] {
    const sparqlLinks = response.results.bindings;
    return sparqlLinks.map((sLink: LinkBinding) => getLinkInfo(sLink));
}

export function getLinksTypesOf(response: SparqlResponse<LinkTypeBinding>): LinkType[] {
    const sparqlLinkTypes = response.results.bindings;
    // Check for owl:Thing as root of concept tree
    if(sparqlLinkTypes.length == 1 && sparqlLinkTypes[0].instcount.value === "0" ) {
        return [];
    }
    return sparqlLinkTypes.map((sLink: LinkTypeBinding) => getLinkType(sLink));
}

/**
 * Get property count of each concepts(concept can be class or individual)
 * @param response
 * @returns {PropertyCount[]}
 */
export function getPropertyCountOfConcepts(response): PropertyCount[] {
    let propertyCounts: PropertyCount[] = [];

    let sparqlPropertyCounts = response.results.bindings;
    // Ensure that this function works in case not any class/individuals in ontology has properties
    if(sparqlPropertyCounts[0].id) {
        sparqlPropertyCounts.forEach(sCount => {
            propertyCounts.push({id: sCount.id.value, count: Number(sCount.count.value)});
        });
    }
    return propertyCounts;
}

export function getFilteredData(response: SparqlResponse<ElementBinding>): Dictionary<ElementModel> {
    const sInstances = response.results.bindings;
    const instancesMap: Dictionary<ElementModel> = {};

    for (const sInst of sInstances) {
        if (sInst.inst.type === 'literal') {
            continue;
        }
        if (!instancesMap[sInst.inst.value]) {
            instancesMap[sInst.inst.value] = getElementInfo(sInst);
        } else {
            enrichElement(instancesMap[sInst.inst.value], sInst);
        }
    };
    return instancesMap;
}

export function enrichElement(element: ElementModel, sInst: ElementBinding) {
    if (!element) { return; }
    if (sInst.label) {
        const localized = getLocalizedString(sInst.label);

        const currentLabels = element.label.values;
        const isAutogeneratedLabel = currentLabels.length === 1 &&
            !currentLabels[0].lang && currentLabels[0].text === getNameFromId(element.id);

        if (isAutogeneratedLabel) {
            element.label.values = [localized];
        } else if (element.label.values.every(value => !isLocalizedEqual(value, localized))) {
            element.label.values.push(localized);
        }
    }
    if (sInst.class && element.types.indexOf(sInst.class.value) < 0) {
        element.types.push(sInst.class.value);
    }
    if (sInst.propType && sInst.propType.value !== LABEL_URI) {
        let property: Property = element.properties[sInst.propType.value];
        if (!property) {
            property = element.properties[sInst.propType.value] = {
                type: 'string', // sInst.propType.value,
                values: [],
            };
        }
        const propertyValue = getPropertyValue(sInst.propValue);
        if (property.values.every(value => !isLocalizedEqual(value, propertyValue))) {
            property.values.push(propertyValue);
        }
    }
}

function isLocalizedEqual(left: LocalizedString, right: LocalizedString) {
    return left.lang === right.lang && left.text === right.text;
}

export function getNameFromId(id: string): string {
    const sharpIndex = id.indexOf('#');
    if (sharpIndex !== -1) {
        return id.substring(sharpIndex + 1, id.length);
    } else {
        const tokens = id.split('/');
        return tokens[tokens.length - 1];
    }
}

export function getLocalizedString(label?: RdfLiteral, id?: string): LocalizedString {
    if (label) {
        return {
            text: label.value,
            lang: label['xml:lang'],
        };
    } else if (id) {
        return {
            text: getNameFromId(id),
            lang: '',
        };
    } else {
        return undefined;
    }
}

export function getInstCount(instcount: RdfLiteral): number {
    return (instcount ? +instcount.value : 0);
}

export function getClassModel(node: ClassBinding): ClassModel {
    return {
        id: node.class.value,
        children: [],
        label: { values: [getLocalizedString(node.label, node.class.value)] },
        count: getInstCount(node.instcount),
    };
}

export function getPropertyModel(node: PropertyBinding): PropertyModel {
    return {
        id: node.prop.value,
        label: { values: [getLocalizedString(node.label, node.prop.value)] },
    };
}

export function getLinkType(sLinkType: LinkTypeBinding): LinkType {
    return {
        id: sLinkType.link.value,
        label: { values: [getLocalizedString(sLinkType.label, sLinkType.link.value)] },
        count: getInstCount(sLinkType.instcount),
    };
}

export function getPropertyValue(propValue?: RdfLiteral): LocalizedString {
    if (!propValue) { return undefined; }
    return {
        lang: propValue['xml:lang'],
        text: propValue.value,
    };
}

export function getElementInfo(sInfo: ElementBinding): ElementModel {
    const elementInfo: ElementModel = {
        id: sInfo.inst.value,
        label: { values: [getLocalizedString(sInfo.label, sInfo.inst.value)] },
        types: (sInfo.class ? [ sInfo.class.value ] : []),
        properties: {},
    };

    if (sInfo.propType && sInfo.propType.value !== LABEL_URI) {
        elementInfo.properties[sInfo.propType.value] = {
            type: 'string', // sInst.propType.value,
            values: [getPropertyValue(sInfo.propValue)],
        };
    }

    return elementInfo;
}

export function getLinkInfo(sLinkInfo: LinkBinding): LinkModel {
    if (!sLinkInfo) { return undefined; }
    return {
        linkTypeId: sLinkInfo.type.value,
        sourceId: sLinkInfo.source.value,
        targetId: sLinkInfo.target.value,
    };
}

export function getLinkTypeInfo(sLinkInfo: LinkTypeInfoBinding): LinkType {
    if (!sLinkInfo) { return undefined; }
    return {
        id: sLinkInfo.typeId.value,
        label: { values: [getLocalizedString(sLinkInfo.label, sLinkInfo.typeId.value)] },
        count: getInstCount(sLinkInfo.instcount),
    };
}
