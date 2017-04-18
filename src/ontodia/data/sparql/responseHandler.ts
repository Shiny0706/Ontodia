import {
    RdfLiteral, SparqlResponse, ClassBinding, ElementBinding, LinkBinding,
    ElementImageBinding, LinkTypeBinding, LinkTypeInfoBinding, PropertyBinding,
} from './sparqlModels';
import {
    Dictionary, LocalizedString, LinkType, ClassModel, ElementModel, LinkModel, Property, PropertyModel, LinkCount, PropertyCount
} from '../model';

const THING_URI = 'http://www.w3.org/2002/07/owl#Thing';
const LABEL_URI = 'http://www.w3.org/2000/01/rdf-schema#label';
const NAME_INDIVIDUAL_URI = "http://www.w3.org/2002/07/owl#NamedIndividual";
const CLASS_URI = "http://www.w3.org/2002/07/owl#Class";
const DATATYPE_PROPERTY_URI = "http://www.w3.org/2002/07/owl#DatatypeProperty";
const FUNCTIONAL_PROPERTY_URI = "http://www.w3.org/2002/07/owl#FunctionalProperty";
const OBJECT_PROPERTY_URI = "http://www.w3.org/2002/07/owl#ObjectProperty";
const TRANSITIVE_PROPERTY_URI = "http://www.w3.org/2002/07/owl#TransitiveProperty";
const SYMMETRIC_PROPERTY_URI = "http://www.w3.org/2002/07/owl#SymmetricProperty";
const ONTOLOGY_URI = "http://www.w3.org/2002/07/owl#Ontology";

export function getClassTree(response: SparqlResponse<ClassBinding>): [ClassModel[], ClassModel[]] {
    const sNodes = response.results.bindings;
    const tree: ClassModel[] = [];
    const createdTreeNodes: Dictionary<ClassModel> = {};
    const tempNodes: Dictionary<ClassModel> = {};
    const pureClassTree: ClassModel[] = [];

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
                if(notOntologyPrimitiveType(newNode.id)) {
                    pureClassTree.push(newNode);
                }
            }
        }
    };

    let thingNode = createdTreeNodes[THING_URI];
    if (!thingNode) {
        let childrenOfThing = [];

        pureClassTree.forEach(function(element) {
            childrenOfThing.push(element);
        });

        thingNode = {
            id: THING_URI,
            children: childrenOfThing,
            label: { values: [getLocalizedString(undefined, THING_URI)] },
            count: 0,
            level: 0,
        };
        tree.push(thingNode);
    } else {
        pureClassTree.forEach(function(element) {
            thingNode.children.push(element);
        });
    }

    return [tree, [thingNode]];
}

function notOntologyPrimitiveType(id: String) {
    let result =
    id != THING_URI
    && id != NAME_INDIVIDUAL_URI
    && id != CLASS_URI
    && id != NAME_INDIVIDUAL_URI
    && id != DATATYPE_PROPERTY_URI
    && id != FUNCTIONAL_PROPERTY_URI
    && id != OBJECT_PROPERTY_URI
    && id != TRANSITIVE_PROPERTY_URI
    && id != SYMMETRIC_PROPERTY_URI
    && id != ONTOLOGY_URI;
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
    return sparqlLinkTypes.map((sLink: LinkTypeBinding) => getLinkType(sLink));
}

export function getLinkCountOfClasses(response): LinkCount[]{
    let linkCount: LinkCount[] = [];
    const sparqlLinkTypes = response.results.bindings;
    sparqlLinkTypes.forEach(sLink => {
        let link = {id: sLink.class.value, count: Number(sLink.propertiesCount.value)};
        linkCount.push(link);
    });

    return linkCount;
}

export function getPropertyCountOfClasses(response): PropertyCount[] {
    let propertyCounts: PropertyCount[] = [];

    let sparqlPropertyCounts = response.results.bindings;
    // Ensure that this function works in case not any class in ontology has properties
    if(sparqlPropertyCounts[0].class) {
        sparqlPropertyCounts.forEach(sCount => {
            propertyCounts.push({id: sCount.class.value, count: Number(sCount.propertyCount.value)});
        });
    }
    return propertyCounts;
}

// Process filtered data returned from SparQL query
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
