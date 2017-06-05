import {difference, each} from "lodash";
import * as Backbone from 'backbone';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as joint from 'jointjs';
import { DiagramView } from '../diagram/view';
import {Dictionary, ElementModel, ConceptModel, PropertyCount} from '../data/model'
import { ConceptRelationsBox } from './conceptRelationsBox';

export interface ClassifierSelectionMenuOptions {
    paper: joint.dia.Paper;
    view: DiagramView;
    elements: Dictionary<ElementModel>;
    onClose: () => void;
    cancelRegimeInstance: () => void;
}

export class ClassifierSelectionMenu {
    private container: HTMLElement;
    private view: DiagramView;
    private handler: Backbone.Model;
    private state: 'loading' | 'completed';
    private links: ElementModel[];
    private markup: ClassifierSelectionMenuMarkup;
    private parentNode: HTMLElement;

    constructor(private options: ClassifierSelectionMenuOptions) {
        this.container = document.createElement('div');
        this.options.paper.el.appendChild(this.container);
        this.view = this.options.view;
        this.handler = new Backbone.Model();
        this.render();
        this.addLinks(options.elements);
    }

    private addLinks(elements: Dictionary<ElementModel>) {
        this.links = [];
        each(elements, element => {
            this.links.push(element);
        });
        this.markup.conceptRelationsBox.setState({items: this.links});
    }

    private render = () => {
        let connectionData = {
            links: this.links,
        };

        ReactDOM.render(React.createElement(ClassifierSelectionMenuMarkup, {
            ref: (markup:ClassifierSelectionMenuMarkup) => {this.markup = markup},
            view: this.options.view,
            connectionData: connectionData,
            state: this.state,
            onButtonSavePressed: this.saveClassifierSelection.bind(this),
            onButtonCancelPressed: () => {
                this.options.cancelRegimeInstance();
                this.options.onClose();
            },
            addDirectLink: (e: DragEvent) =>  {
                this.updateLinksBox(e, this.markup.directRelationsBox);
            },
            addReverseLink: (e: DragEvent) => {
                this.updateLinksBox(e, this.markup.reverseRelationsBox);
            },
            restoreLink: (e: DragEvent) => {
                this.updateLinksBox(e, this.markup.conceptRelationsBox);
            },
        } as ClassifierSelectionMenuMarkupProps), this.container);
    };

    private updateLinksBox(e: DragEvent, targetComponent: ConceptRelationsBox) {
        let {elementIds, source} = parseDataTransfer(e);
        if(! elementIds || !source) {
            return;
        }

        let newItems: ElementModel[]= [];
        for(let id of elementIds) {
            newItems.push(this.options.elements[id]);
        }

        let sourceComponent: ConceptRelationsBox = undefined;
        if(source === 'all-links') {
            sourceComponent = this.markup.conceptRelationsBox;
        } else if(source === 'direct-links') {
            sourceComponent = this.markup.directRelationsBox;
        } else {
            sourceComponent = this.markup.reverseRelationsBox;
        }

        if(sourceComponent === targetComponent) {
            return;
        }

        sourceComponent.setState({items: difference(sourceComponent.state.items, newItems)});

        targetComponent.setState({
            items: targetComponent.state.items.concat(newItems)
        });
    }

    remove() {
        this.handler.stopListening();
        ReactDOM.unmountComponentAtNode(this.container);
        this.options.paper.el.removeChild(this.container);
    }

    private saveClassifierSelection() {
        if(this.markup.directRelationsBox.state.items.length == 0 
            && this.markup.reverseRelationsBox.state.items.length == 0) {
            alert("Please select a classifiers");
            return;
        }

        let directLinkIds: string[] = [];
        let reverseLinkIds: string[] = [];
        each(this.markup.directRelationsBox.state.items, item => {
           directLinkIds.push(item.id);
        });
        each(this.markup.reverseRelationsBox.state.items, item => {
           reverseLinkIds.push(item.id);
        });

        let dataProvider = this.view.model.dataProvider;

        Promise.all<ConceptModel, PropertyCount[]>([
            dataProvider.instanceConceptsTree(directLinkIds, reverseLinkIds),
            dataProvider.propertyCountOfIndividuals()
            ])
            .then(([instanceConceptsTree, propertyCount]) => {
                this.view.model.setConceptTree(instanceConceptsTree, propertyCount);
                this.view.model.setRegime('individual');
                this.view.clearPaper();
                this.options.onClose();
            });
    }
}

export interface ClassifierSelectionMenuMarkupProps {
    view: DiagramView;
    state: 'loading' | 'completed';
    connectionData: {
        links: ElementModel[]
    }
    onButtonSavePressed: () => void;
    onButtonCancelPressed: () => void;
    addDirectLink:(e: DragEvent) => void;
    addReverseLink: (e: DragEvent) => void;
    restoreLink: (e: DragEvent) => void;
}

const CLASS_NAME='kce-classifier-selection';

export class ClassifierSelectionMenuMarkup extends React.Component<ClassifierSelectionMenuMarkupProps, {}> {
    element: HTMLElement;
    directRelationsBox: ConceptRelationsBox;
    reverseRelationsBox: ConceptRelationsBox;
    conceptRelationsBox: ConceptRelationsBox;

    constructor(props: ClassifierSelectionMenuMarkupProps) {
        super(props);
        this.render();
    }

    render() {
        return (
            <div className={CLASS_NAME}>
                <label className={`${CLASS_NAME}__title-label`}>Classifiers selection</label>
                <div className={`${CLASS_NAME}__links-panels`}>
                    <div className={`${CLASS_NAME}__links-panels__all-links`}>
                        <ConceptRelationsBox
                            items={this.props.connectionData.links}
                            title="Object relations"
                            view={this.props.view}
                            id="all-links"
                            onDragDrop={this.props.restoreLink}
                            ref={el => this.conceptRelationsBox = el}/>
                    </div>
                    <div className={`${CLASS_NAME}__links-panels__selected`}>
                        <div className={`${CLASS_NAME}__links-panels__selected__direct-links`}>
                            <ConceptRelationsBox
                                items={[]}
                                title="Classifiers"
                                view={this.props.view}
                                id="direct-links"
                                onDragDrop={this.props.addDirectLink}
                                ref={el => this.directRelationsBox = el}/>
                        </div>
                        <div className={`${CLASS_NAME}__links-panels__selected__reverse-links`}>
                            <ConceptRelationsBox
                                items={[]}
                                title ="Inverse classifiers"
                                view={this.props.view}
                                id="reverse-links"
                                onDragDrop={this.props.addReverseLink}
                                ref={el => this.reverseRelationsBox = el}/>
                        </div>
                    </div>
                </div>
                <div>
                    <button className={`${CLASS_NAME}__btn-save btn btn-primary pull-right`} onClick={this.props.onButtonSavePressed}>Save</button>
                    <button className={`${CLASS_NAME}__btn-save btn btn-primary pull-right`} onClick={this.props.onButtonCancelPressed}>Cancel</button>
                </div>
            </div>
        );
    }
}

function parseDataTransfer(e: DragEvent): {elementIds: string[], source: string} {
    e.preventDefault();
    let dataTransfer = undefined;
    try {
        // Elements dragged from filter panel
        dataTransfer = JSON.parse(e.dataTransfer.getData('application/x-ontodia-elements'));
    } catch (ex) {
        try {
            dataTransfer = JSON.parse(e.dataTransfer.getData('text')); // IE fix
        } catch (ex) {
            console.error(ex);
        }
    }
    if (!dataTransfer) { return {elementIds: undefined, source: undefined}; }
    return {elementIds: dataTransfer.elementIds, source: dataTransfer.source};
}

