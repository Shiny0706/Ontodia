import * as React from 'react';
import * as joint from 'jointjs';
import {difference, each} from "lodash";
import * as Backbone from 'backbone';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import {FilterParams } from  '../data/provider';
import { DiagramView } from '../diagram/view';
import {Dictionary, ElementModel, ConceptModel} from '../data/model'
import { ConceptRelationsBox } from './conceptRelationsBox';
import {SearchCriteria, createRequest} from "./instancesSearch";
export interface ClassifierSelectionMenuOptions {
    paper: joint.dia.Paper;
    view: DiagramView;
    linkRetrieveCriteria: SearchCriteria;
    onClose: () => void;
}
export class ClassifierSelectionMenu {
    private container: HTMLElement;
    private view: DiagramView;
    private handler: Backbone.Model;
    private state: 'loading' | 'completed';
    private links: ElementModel[];
    private markup: ClassifierSelectionMenuMarkup;
    private loadedElements: Dictionary<ElementModel>;

    constructor(private options: ClassifierSelectionMenuOptions) {
        this.container = document.createElement('div');
        this.options.paper.el.appendChild(this.container);
        this.view = this.options.view;
        this.handler = new Backbone.Model();
        this.loadConceptsRelation();
        this.render();
    }

    private render = () => {
        let connectionData = {
            links: this.links,
        };

        ReactDOM.render(React.createElement(ClassifierSelectionMenuMarkup, {
            ref: markup => {this.markup = markup},
            view: this.options.view,
            connectionData: connectionData,
            state: this.state,
            onButtonSavePressed: this.saveClassifierSelection.bind(this),
            addDirectLink: (e: DragEvent) =>  {
                this.updateLinksBox(e, this.markup.directRelationsBox);
            },
            addReverseLink: (e: DragEvent) => {
                this.updateLinksBox(e, this.markup.reverseRelationsBox);
            },
            restoreLink: (e: DragEvent) => {
                this.updateLinksBox(e, this.markup.conceptRelationsBox);
            },
        }), this.container);
    };

    private updateLinksBox(e: DragEvent, targetComponent: ConceptRelationsBox) {
        let {elementIds, source} = ClassifierSelectionMenu.parseDataTransfer(e);
        if(! elementIds || !source) {
            return;
        }

        let newItems: ElementModel[]= [];
        for(let id of elementIds) {
            newItems.push(this.loadedElements[id]);
        }

        targetComponent.setState({
            items: targetComponent.state.items.concat(newItems)
        });

        let sourceComponent: ConceptRelationsBox = undefined;
        if(source === 'all-links') {
            sourceComponent = this.markup.conceptRelationsBox;
        } else if(source === 'direct-links') {
            sourceComponent = this.markup.directRelationsBox;
        } else {
            sourceComponent = this.markup.reverseRelationsBox;
        }
        sourceComponent.setState({items: difference(sourceComponent.state.items, newItems)});
    }

    private static parseDataTransfer(e: DragEvent): {elementIds: string[], source: string} {
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

    private loadConceptsRelation() {
        this.state = 'loading';
        this.links = [];
        let request: FilterParams = createRequest(this.options.linkRetrieveCriteria, this.options.view.getLanguage());

        this.options.view.model.dataProvider.filter(request).then(elements => {
            this.state = 'completed';
            this.processFilterLinksData(elements);
            this.markup.conceptRelationsBox.setState({items: this.links});
            this.render();
        }).catch(error => {
            console.error(error);
        });
    }

    private processFilterLinksData(elements: Dictionary<ElementModel>) {
        this.loadedElements = elements;
        const newItems: ElementModel[] = [];
        for (const elementId in elements) {
            let element = elements[elementId];
            newItems.push(element);
        }
        this.links = newItems;
    }

    remove() {
        this.handler.stopListening();
        ReactDOM.unmountComponentAtNode(this.container);
        this.options.paper.el.removeChild(this.container);
    }

    private saveClassifierSelection() {
        if(this.markup.directRelationsBox.state.items.length == 0) {
            alert("Please select a classifier direct links");
        } else {
            let directLinkIds: string[] = [];
            let reverseLinkIds: string[] = [];
            each(this.markup.directRelationsBox.state.items, item => {
               directLinkIds.push(item.id);
            });
            each(this.markup.reverseRelationsBox.state.items, item => {
               reverseLinkIds.push(item.id);
            });
            this.view.model.setClassifierLinks(directLinkIds, reverseLinkIds);
            let classId: string = "http://www.semanticweb.org/elenasarkisova/ontologies/2016/1/csample/Concept";
            let dataProvider = this.view.model.dataProvider;

            Promise.all<ConceptModel[]>([
                dataProvider.reverseInstanceConceptsTree(classId, directLinkIds),
                dataProvider.propertyCountOfIndividuals(classId)
                ])
                .then(([instanceConceptsTree, propertyCount]) => {
                    this.view.model.setConceptTree(instanceConceptsTree, propertyCount);
                    this.options.onClose();
                }) ;

        }
    }
}

export interface ClassifierSelectionMenuMarkupProps {
    view: DiagramView;
    state: 'loading' | 'completed';
    connectionData: {
        links: ElementModel[]
    }
    onButtonSavePressed: () => void;
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


    //
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
                                items=undefined
                                title="Direct classifying relations"
                                view={this.props.view}
                                id="direct-links"
                                onDragDrop={this.props.addDirectLink}
                                ref={el => this.directRelationsBox = el}/>
                        </div>
                        <div className={`${CLASS_NAME}__links-panels__selected__reverse-links`}>
                            <ConceptRelationsBox
                                items=undefined
                                title ="Inverse classifying relations"
                                view={this.props.view}
                                id="reverse-links"
                                onDragDrop={this.props.addReverseLink}
                                ref={el => this.reverseRelationsBox = el}/>
                        </div>
                    </div>
                </div>
                <div>
                    <button className={`${CLASS_NAME}__btn-save btn btn-primary pull-right`} onClick={this.props.onButtonSavePressed}>Save</button>
                </div>
            </div>
        );
    }
}

