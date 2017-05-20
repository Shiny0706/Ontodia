export type Dictionary<T> = { [key: string]: T; };

export interface LocalizedString {
    text: string;
    lang: string;
}

export type Property = { type: 'string'; values: LocalizedString[]; };

export interface ElementModel {
    id: string;
    types: string[];
    label: { values: LocalizedString[] };
    image?: string;
    properties: { [id: string]: Property };
}

export interface LinkModel {
    linkTypeId: string;
    sourceId: string;
    targetId: string;
    directLink: boolean;
}

export interface ClassModel {
    id: string;
    label: { values: LocalizedString[] };
    count: number;
    children: ClassModel[];
    parent: string;
}

export interface PropertyCount {
    id: string,
    count: number;
}

export interface LinkCount {
    id: string;
    count: number;
}

export interface LinkType extends LinkCount {
    label: { values: LocalizedString[] };
}

export interface PropertyModel {
    id: string;
    label: { values: LocalizedString[] };
}

export interface ConceptModel {
    id: string;
    label: { values: LocalizedString[] };
    count: number; // This field is for concept as class
    children: ConceptModel[];
    parent: ConceptModel[];
    level?:number;
    aGlobalDensity?: number;
    globalDensity?: number;
    localDensity?: number;
    density?: number;
    contribution?: number;
    nameSimplicity?: number;
    basicLevel?: number;
    ncValue?: number;
    propertyCount?: number;
    score?: number;
    overallScore?: number;
    covered: ConceptModel[];
    allSuperConcepts: ConceptModel[];
    allSubConcepts: ConceptModel[];
    indirectSubConcepts: ConceptModel[];
    subKeyConcepts: ConceptModel[];
    presentOnDiagram?: boolean;
}


export interface BFSConceptModel {
    id: string;
    checked: boolean;
}
