import * as Backbone from 'backbone';
import * as joint from 'jointjs';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

import DiagramView from '../diagram/view';
import { chooseLocalizedText } from '../diagram/model';

import { ConceptModel } from '../data/model';
import {Link} from "../diagram/elements";

export interface IsAPathMenuOptions {
    paper: joint.dia.Paper;
    view: DiagramView;
    cellView: joint.dia.CellView;
    onClose: () => void;
}

const MENU_OFFSET = 40;

export class IsAPathMenu {
    private container: HTMLElement;
    private view: DiagramView;
    private handler: Backbone.Model;
    private state: 'loading' | 'completed';

    private superConcepts: ConceptModel[];
    private cellView: joint.dia.CellView;

    constructor(private options: IsAPathMenuOptions) {
        this.container = document.createElement('div');
        this.options.paper.el.appendChild(this.container);

        this.cellView = this.options.cellView;
        this.view = this.options.view;

        this.handler = new Backbone.Model();
        this.handler.listenTo(this.options.cellView.model,
            'change:isExpanded change:position change:size', this.render);
        this.handler.listenTo(this.options.paper, 'scale', this.render);
        this.handler.listenTo(this.view, 'change:language', this.render);

        this.loadIsAPath();
        this.render();
    }

    private loadIsAPath() {
        this.state = 'loading';
        let link : Link = this.cellView.model as Link;
        this.superConcepts = this.view.model.getIsAPath(link.sourceId, link.targetId);

        this.state = 'completed';
        this.render();
    }

    private render = () => {

        const isAPathData = {
            superConcepts: this.superConcepts || []
        };

        ReactDOM.render(React.createElement(IsAPathMenuMarkup, {
            cellView: this.options.cellView,
            isAPathData: isAPathData,
            state: this.state,
            lang: this.view.getLanguage(),
        }), this.container);
    };

    remove() {
        this.handler.stopListening();
        ReactDOM.unmountComponentAtNode(this.container);
        this.options.paper.el.removeChild(this.container);
    }

}

export interface IsAPathMenuMarkupProps {
    cellView: joint.dia.CellView;

    isAPathData: {
        superConcepts: ConceptModel[];
    };

    lang: string;
    state: 'loading' | 'completed';
}

export class IsAPathMenuMarkup  extends React.Component<IsAPathMenuMarkupProps, {}> {

    constructor (props: IsAPathMenuMarkupProps) {
        super(props);
    }

    private getTitle = () => {
        return 'Is-a path';
    };

    private getBody = () => {
        if (this.props.isAPathData) {
            return <SuperConceptsList
                data={this.props.isAPathData}
                lang={this.props.lang}/>
        } else {
            return <div/>;
        }
    };

    render() {
        const bBox = this.props.cellView.getBBox();
        const style = {
            top: (bBox.y + bBox.height / 2 - 75),
            left: (bBox.x + bBox.width + MENU_OFFSET),
            backgroundColor: 'white',
            border: '1px solid black',
        };

        return (
            <div className='ontodia-is-a-path-menu' style={style}>
                <label className='ontodia-is-a-path-menu__title-label'>{this.getTitle()}</label>
                {this.getBody()}
            </div>
        );
    }
}

export interface SuperConceptsListProps {
    data: {
        superConcepts: ConceptModel[];
    };
    lang: string;
}

export class SuperConceptsList extends React.Component<SuperConceptsListProps, {}> {

    constructor (props: SuperConceptsListProps) {
        super(props);
    }
    private getViews = (concepts: ConceptModel[]) => {
        const views: React.ReactElement<any>[] = [];
        for (const concept of concepts) {
            views.push(
                <SuperConceptInPopupMenu
                    key={concept.id}
                    concept={concept}
                />
            );
        }
        return views;
    };

    render() {
        let viewList: React.ReactElement<any> | React.ReactElement<any>[];
        let views= this.getViews(this.props.data.superConcepts);
        viewList = views;
        return <ul className={
            'ontodia-connections-menu_links-list '
                + (views.length === 0 ? 'ocm_links-list-empty' : '')
        }>{viewList}</ul>;
    }
}

export interface SuperConceptInPopupMenuProps {
    lang?: string;
    concept: ConceptModel;
}

export class SuperConceptInPopupMenu extends React.Component<SuperConceptInPopupMenuProps, {}> {
    constructor(props: SuperConceptInPopupMenuProps) {
        super(props);
    }

    render() {
        const fullText = chooseLocalizedText(this.props.concept.label.values, this.props.lang).text;
        return (
            <li data-conceptId={this.props.concept.id} className='link-in-popup-menu'>
                <div className='link-in-popup-menu__link-title'
                     title={'Naviagte to connected by link \'' + fullText + '\' elements'}
                >
                    {fullText}
                </div>
            </li>
        );
    }
}
