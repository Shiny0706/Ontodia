import { createElement, ClassAttributes } from 'react';
import * as ReactDOM from 'react-dom';
import Config  from '../../stardogConfig';

import { Workspace, WorkspaceProps, SparqlDataProvider } from '../index';

import { onPageLoad, tryLoadLayoutFromLocalStorage, saveLayoutToLocalStorage } from './common';

require('jointjs/css/layout.css');
require('jointjs/css/themes/default.css');

function onWorkspaceMounted(workspace: Workspace) {
    if (!workspace) { return; }

    const model = workspace.getModel();
    model.graph.on('action:iriClick', (iri: string) => {
        window.open(iri);
        console.log(iri);
    });

    let stardogEndpoint = getParam('uri');

    // load default stardog endpoint from config file if param uri not found
    if(!stardogEndpoint) {
        stardogEndpoint = Config.HOSTNAME + ':' + Config.PORT +'/' + Config.DB + '/query';
    }

    const layoutData = tryLoadLayoutFromLocalStorage();
    model.importLayout({
        layoutData,
        validateLinks: true,
        dataProvider: new SparqlDataProvider({
            endpointUrl: stardogEndpoint,
            imageClassUris: [
                'http://collection.britishmuseum.org/id/ontology/PX_has_main_representation',
                'http://xmlns.com/foaf/0.1/img',
            ],
        }),
    });
}

let getParam = function (name: string) {
    let match=(new RegExp('[?&]'+encodeURIComponent(name)+'=([^&]*)')).exec(location.search);
    if(match) {
        return decodeURIComponent(match[1]);
    }
    return null;
}

const props: WorkspaceProps & ClassAttributes<Workspace> = {
    ref: onWorkspaceMounted,
    onSaveDiagram: workspace => {
        const {layoutData} = workspace.getModel().exportLayout();
        window.location.hash = saveLayoutToLocalStorage(layoutData);
        window.location.reload();
    },
};

onPageLoad(container => ReactDOM.render(createElement(Workspace, props), container));
