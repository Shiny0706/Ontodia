import { LinkStyle, LinkStyleResolver } from './props';

const LINK_SUB_CLASS_OF: LinkStyle = {
    connection: {
        stroke: '#bf2f28',
        'stroke-width': 2,
    },
    markerTarget: {
        fill: '#bf2f28',
        stroke: '#cf8e76',
    },
};

const LINK_INDIRECT_RELATION: LinkStyle = {
    connection: {
        stroke: '#bf2f28',
        'stroke-width': 2,
        'stroke-dasharray': '5,5',
    },
    markerTarget: {
        fill: '#bf2f28',
        stroke: '#cf8e76',
    },
};

const LINK_DOMAIN: LinkStyle = {
    connection: {
        stroke: '#34c7f3',
        'stroke-width': 2,
    },
    markerTarget: {
        fill: '#34c7f3',
        stroke: '#38b5db',
    },
};

const LINK_RANGE: LinkStyle = {
    connection: {
        stroke: '#34c7f3',
        'stroke-width': 2,
    },
    markerTarget: {
        fill: '#34c7f3',
        stroke: '#38b5db',
    },
};

const LINK_TYPE_OF: LinkStyle = {
    connection: {
        stroke: '#8cd965',
        'stroke-width': 2,
    },
    markerTarget: {
        fill: '#8cd965',
        stroke: '#5b9a3b',
    },
};

export const DefaultLinkStyleBundle: LinkStyleResolver[] = [
    (type, directLink)  => {
        if (type === 'http://www.w3.org/2000/01/rdf-schema#subClassOf') {
            if(directLink) {
                return LINK_SUB_CLASS_OF;
            } else {
                return LINK_INDIRECT_RELATION;
            }
        } else if (type === 'http://www.w3.org/2000/01/rdf-schema#domain') {
            return LINK_DOMAIN;
        } else if (type === 'http://www.w3.org/2000/01/rdf-schema#range') {
            return LINK_RANGE;
        } else if (type === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') {
            return LINK_TYPE_OF;
        } else if (type === 'http://www.semanticweb.org/tuyenhuynh/ontologies/2017/1/kce#hasRelationWith') {
            return LINK_INDIRECT_RELATION;
        } else {
            return undefined;
        }
    },
];
