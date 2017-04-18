import * as $ from 'jquery';
import { Component, createElement, ReactElement} from 'react';
import * as Backbone from 'backbone';
import {each} from 'lodash';

import {DiagramModel, ClassTreeElement} from '../diagram/model';
import { Link, FatLinkType, FatClassModel } from '../diagram/elements';
import { DiagramView, DiagramViewOptions } from '../diagram/view';
import {
    forceLayout, removeOverlaps, padded, translateToPositiveQuadrant,
    LayoutNode, LayoutLink, translateToCenter,
} from '../viewUtils/layout';
import {radialTreeLayout, RadialLayoutNode} from '../viewUtils/radialTreeLayout';

import { ClassTree } from '../widgets/classTree';
import { LinkTypesToolboxShell, LinkTypesToolboxModel } from '../widgets/linksToolbox';
import { dataURLToBlob } from '../viewUtils/toSvg';

import { EditorToolbar, Props as EditorToolbarProps } from '../widgets/toolbar';
import { SearchCriteria } from '../widgets/instancesSearch';
import { showTutorial, showTutorialIfNotSeen } from '../tutorial/tutorial';

import { WorkspaceMarkup, Props as MarkupProps } from './workspaceMarkup';
import {getLocalizedString } from '../data/sparql/responseHandler';

export interface Props {
    onSaveDiagram?: (workspace: Workspace) => void;
    onShareDiagram?: (workspace: Workspace) => void;
    onEditAtMainSite?: (workspace: Workspace) => void;
    isViewOnly?: boolean;
    isDiagramSaved?: boolean;
    hideTutorial?: boolean;
    viewOptions?: DiagramViewOptions;
}

export interface State {
    readonly criteria?: SearchCriteria;
}

export class Workspace extends Component<Props, State> {
    // markup contains class tree (left), paper area and connection panel (right)
    static readonly defaultProps: { [K in keyof Props]?: any } = {
        hideTutorial: true,
    };

    private markup: WorkspaceMarkup;

    private readonly model: DiagramModel;
    private readonly diagram: DiagramView;
    private tree: ClassTree;
    private linksToolbox: LinkTypesToolboxShell;

    constructor(props: Props) {
        super(props);
        this.model = new DiagramModel(this.props.isViewOnly);
        this.diagram = new DiagramView(this.model, this.props.viewOptions);
        this.state = {};
    }

    render(): ReactElement<any> {
        return createElement(WorkspaceMarkup, {
            ref: markup => { this.markup = markup; },
            isViewOnly: this.props.isViewOnly,
            view: this.diagram,
            searchCriteria: this.state.criteria,
            onSearchCriteriaChanged: criteria => this.setState({criteria}),
            toolbar: createElement<EditorToolbarProps>(EditorToolbar, {
                onUndo: this.undo,
                onRedo: this.redo,
                onZoomIn: this.zoomIn,
                onZoomOut: this.zoomOut,
                onZoomToFit: this.zoomToFit,
                onPrint: this.print,
                onExportSVG: this.exportSvg,
                onExportPNG: this.exportPng,
                onShare: this.props.onShareDiagram ? () => this.props.onShareDiagram(this) : undefined,
                onSaveDiagram: () => this.props.onSaveDiagram(this),
                onForceLayout: () => {
                    this.forceLayout();
                    this.zoomToFit();
                },
                onChangeLanguage: this.changeLanguage,
                onShowTutorial: showTutorial,
                onEditAtMainSite: () => this.props.onEditAtMainSite(this),
                isEmbeddedMode: this.props.isViewOnly,
                isDiagramSaved: this.props.isDiagramSaved,
                isIntegratingMode: true,
                onChangeDrawingMode: drawingMode => this.diagram.visualizeCognitiveInformationSpace(drawingMode),
                onClearPaper: () => this.diagram.clearPaper()
            }),
        } as MarkupProps & React.ClassAttributes<WorkspaceMarkup>);
    }

    componentDidMount() {
        this.diagram.initializePaperComponents();

        if (this.props.isViewOnly) { return; }

        this.tree = new ClassTree({
            model: new Backbone.Model(this.diagram.model),
            view: this.diagram,
            el: this.markup.classTreePanel,
        }).render();

        this.tree.on('action:classSelected', (classId: string) => {
            this.setState({criteria: {elementTypeId: classId}});
        });
        this.model.graph.on('add-to-filter', (element: Element, linkType?: FatLinkType) => {
            this.setState({criteria: {refElementId: element.id, refElementLinkId: linkType && linkType.id}});
        });

        this.diagram.listenTo(this.model, 'state:linksInfoCreated', () => {
            //this.markup.paperArea.zoomToFit();
        });

        // Create links toolbox
        this.linksToolbox = new LinkTypesToolboxShell({
            model: new LinkTypesToolboxModel(this.model),
            view: this.diagram,
            el: this.markup.linkTypesPanel,
        });

        if (!this.props.hideTutorial) {
            showTutorialIfNotSeen();
        }
    }

    componentWillUnmount() {
        if (this.tree) {
            this.tree.remove();
        }

        this.diagram.dispose();
    }

    getModel() { return this.model; }
    getDiagram() { return this.diagram; }

    preventTextSelectionUntilMouseUp() { this.markup.preventTextSelection(); }

    zoomToFit = () => {
        this.markup.paperArea.zoomToFit();
    }

    showWaitIndicatorWhile(promise: Promise<any>) {
        this.markup.paperArea.showIndicator(promise);
    }

    forceLayout = () => {
        const nodes: LayoutNode[] = [];
        const nodeById: { [id: string]: LayoutNode } = {};
        for (const element of this.model.elements) {
            const size = element.get('size');
            const position = element.get('position');
            const node: LayoutNode = {
                id: element.id,
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            };
            nodeById[element.id] = node;
            nodes.push(node);
        }

        type LinkWithReference = LayoutLink & { link: Link };
        const links: LinkWithReference[] = [];
        for (const link of this.model.links) {
            if (!this.model.isSourceAndTargetVisible(link)) { continue; }
            const source = this.model.sourceOf(link);
            const target = this.model.targetOf(link);
            links.push({
                link,
                source: nodeById[source.id],
                target: nodeById[target.id],
            });
        }

        forceLayout({nodes, links, preferredLinkLength: 200});
        padded(nodes, {x: 10, y: 10}, () => removeOverlaps(nodes));
        translateToPositiveQuadrant({nodes, padding: {x: 150, y: 150}});
        for (const node of nodes) {
            this.model.getElement(node.id).position(node.x, node.y);
        }
        this.markup.paperArea.adjustPaper();
        translateToCenter({
            nodes,
            paperSize: this.markup.paperArea.getPaperSize(),
            contentBBox: this.markup.paperArea.getContentFittingBox(),
        });

        for (const node of nodes) {
            this.model.getElement(node.id).position(node.x, node.y);
        }

        for (const {link} of links) {
            link.set('vertices', []);
        }
    }

    radialLayout = () => {
        let deltaRadius = 250;
        let paperSize = this.markup.paperArea.getPaperSize();
        let rootX = paperSize.width/2;
        let rootY = paperSize.height/2;
        let model = this.model;
        let pureClassTree :ClassTreeElement[] = this.model.getPureClassTree();
        let root: ClassTreeElement;
        if(pureClassTree.length > 1) {
            const CLASS_URI = "http://www.w3.org/2002/07/owl#Class";
            root = {
                id: CLASS_URI,
                label: {values: [getLocalizedString(undefined, CLASS_URI)]},
                count: pureClassTree.length,
                children: pureClassTree,
            };
        }else {
            root = pureClassTree[0];
        }

        let nodeList: RadialLayoutNode[] = [];
        let createRadialTree = function(treeElement: ClassTreeElement): RadialLayoutNode {
            let element = model.getElement(treeElement.id);
            let width, height, x, y;
            if(element === undefined) {
                width = 100;
                height = 50;
            }else {
                let size = element.get('size');
                width = size.width;
                height = size.height;
            }
            let node: RadialLayoutNode = {
                id: treeElement.id,
                height: height,
                width: width,
                children: []
            };
            each(treeElement.children , child => {
                let childNode = createRadialTree(child);
                node.children.push(childNode);
            });
            nodeList.push(node);
            return node;
        };

        let layoutRoot: RadialLayoutNode = createRadialTree(root);

        radialTreeLayout({root: layoutRoot, deltaRadius: deltaRadius, rootX: rootX, rootY: rootY});
        each(nodeList, node => {
            let nodeModel = this.model.getElement(node.id);
            if(nodeModel) {
                nodeModel.position(node.x, node.y);
            }
        });

        layoutRoot.x = paperSize.width/2;
        layoutRoot.y = paperSize.height/2;
        this.diagram.createElementAt(layoutRoot.id, {x: layoutRoot.x, y: layoutRoot.y});
    }

    exportSvg = (link: HTMLAnchorElement) => {
        this.diagram.exportSVG().then(svg => {
            link.download = 'diagram.svg';
            const xmlEncodingHeader = '<?xml version="1.0" encoding="UTF-8"?>';
            link.href = window.URL.createObjectURL(
                new Blob([xmlEncodingHeader + svg], {type: 'image/svg+xml'}));
            link.click();
        });
    }

    exportPng = (link: HTMLAnchorElement) => {
        this.diagram.exportPNG({backgroundColor: 'white'}).then(dataUri => {
            link.download = 'diagram.png';
            link.href = window.URL.createObjectURL(dataURLToBlob(dataUri));
            link.click();
        });
    }

    undo = () => {
        this.model.undo();
    }

    redo = () => {
        this.model.redo();
    }

    zoomIn = () => {
        this.markup.paperArea.zoomBy(0.2);
    }

    zoomOut = () => {
        this.markup.paperArea.zoomBy(-0.2);
    }

    print = () => {
        this.diagram.print();
    }

    changeLanguage = (language: string) => {
        this.diagram.setLanguage(language);
    }
}

export default Workspace;
