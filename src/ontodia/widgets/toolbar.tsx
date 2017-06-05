import * as React from 'react';

export interface Props {
    onSaveDiagram?: () => void;
    onSaveToSelf?: () => void;
    onEditAtMainSite?: () => void;
    onResetDiagram?: () => void;
    onForceLayout: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onZoomToFit: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onExportSVG: (link: HTMLAnchorElement) => void;
    onExportPNG: (link: HTMLAnchorElement) => void;
    onPrint: () => void;
    onPreviousKCEView: () => void;
    onShare?: () => void;
    onChangeLanguage: (language: string) => void;
    onShowTutorial: () => void;
    isEmbeddedMode?: boolean;
    isDiagramSaved?: boolean;
    onVisualizeWithKCE?: (conceptCount: number) => void;
    onChangeRegime: (regime: string) => void;
}

export interface State {
    showModal: boolean;
    conceptCount: number;
}

const CLASS_NAME = 'ontodia-toolbar';

export class EditorToolbar extends React.Component<Props, State> {
    private downloadImageLink: HTMLAnchorElement;
    private regime: HTMLSelectElement;

    constructor(props: Props) {
        super(props);
        this.state = {showModal: false, conceptCount: 16};
    }

    private onChangeLanguage = (event: React.SyntheticEvent<HTMLSelectElement>) => {
        const value = event.currentTarget.value;
        this.props.onChangeLanguage(value);
    };

    private onChangeRegime = (event: React.SyntheticEvent<HTMLSelectElement>) => {
        const value = event.currentTarget.value;
        this.props.onChangeRegime(value);
    };

    private onExportSVG = () => {
        this.props.onExportSVG(this.downloadImageLink);
    };

    private onExportPNG = () => {
        this.props.onExportPNG(this.downloadImageLink);
    };

    private onVisualizeWithKCE = () => {
        this.props.onVisualizeWithKCE(this.state.conceptCount);
    };

    private onConceptCountChange = (event: React.SyntheticEvent<HTMLInputElement>) => {
        this.setState({conceptCount: Number(event.currentTarget.value),
            showModal: this.state.showModal
        });
    };

    public restoreClassRegime = () => {
        this.regime.value = "class";
    };

    render() {
        const intro = '<h4>Toolbox</h4>' +
            '<p>You can use additional tools for working with your diagram, such as choosing between automatic ' +
            'layouts or fit diagram to screen, etc.</p>' +
            '<p>Don’t forget to save diagrams, it always comes handy after all.</p>';

        let btnSaveDiagram = (
            <button type='button' className='saveDiagramButton btn btn-primary'
                    onClick={this.props.onSaveDiagram}>
                <span className='fa fa-floppy-o' aria-hidden='true' /> Save diagram
            </button>
        );

        let btnEditAtMainSite = (
            <button type='button' className='btn btn-primary' onClick={this.props.onEditAtMainSite}>
                Edit in <img src='images/ontodia_headlogo.png' height='15.59'/>
            </button>
        );

        let btnShare = (
            <button type='button' className='btn btn-default'
                    title='Publish or share diagram' onClick={this.props.onShare}>
                <span className='fa fa-users' aria-hidden='true' /> Share
            </button>
        );

        let btnHelp = (
            <button type='button' className='btn btn-default'
                    onClick={this.props.onShowTutorial}>
                <span className='fa fa-info-circle' aria-hidden='true' /> Help
            </button>
        );

        const nonEmbedded = !this.props.isEmbeddedMode;
        return (
            <div className={CLASS_NAME}>
                <div className='btn-group btn-group-sm'
                     data-position='bottom' data-step='6' data-intro={intro}>
                    {nonEmbedded
                        ? (this.props.onSaveDiagram ? btnSaveDiagram : undefined)
                        : (this.props.onEditAtMainSite ? btnEditAtMainSite : undefined)}
                    {this.props.onSaveToSelf ? (
                        <button type='button' className='btn btn-default'>
                            <span className='fa fa-floppy-o' aria-hidden='true'></span> Save under your account
                        </button>
                    ) : undefined}
                    {(this.props.isDiagramSaved && this.props.onResetDiagram) ? (
                        <button type='button' className='btn btn-default'>
                            <span className='fa fa-trash-o' aria-hidden='true'></span> Reset
                        </button>
                    ) : undefined}
                    <button type='button' className='btn btn-default'
                            onClick={this.props.onForceLayout}>
                        <span className='fa fa-sitemap' aria-hidden='true' /> Layout
                    </button>
                    <button type='button' className='btn btn-default'
                            title='Zoom In' onClick={this.props.onZoomIn}>
                        <span className='fa fa-search-plus' aria-hidden='true' />
                    </button>
                    <button type='button' className='btn btn-default'
                            title='Zoom Out' onClick={this.props.onZoomOut}>
                        <span className='fa fa-search-minus' aria-hidden='true' />
                    </button>
                    <button type='button' className='btn btn-default'
                            title='Fit to Screen' onClick={this.props.onZoomToFit}>
                        <span className='fa fa-arrows-alt' aria-hidden='true' />
                    </button>
                    {(nonEmbedded && this.props.onUndo) ? (
                        <button type='button' className={`btn btn-default ${CLASS_NAME}__undo`}
                            title='Undo' onClick={this.props.onUndo}>
                            <span className='fa fa-undo' aria-hidden='true' />
                        </button>
                    ) : undefined}
                    {(nonEmbedded && this.props.onRedo) ? (
                        <button type='button' className={`btn btn-default ${CLASS_NAME}__redo`}
                            title='Redo' onClick={this.props.onRedo}>
                            <span className='fa fa-repeat' aria-hidden='true' />
                        </button>
                    ) : undefined}
                    <button type='button' className='btn btn-default'
                            title='Export diagram as PNG' onClick={this.onExportPNG}>
                        <span className='fa fa-picture-o' aria-hidden='true' /> PNG
                    </button>
                    <button type='button' className='btn btn-default'
                            title='Export diagram as SVG' onClick={this.onExportSVG}>
                        <span className='fa fa-picture-o' aria-hidden='true' /> SVG
                    </button>
                    {(!nonEmbedded) ? (
                    <button type='button' className='btn btn-default'
                            title='Print diagram' onClick={this.props.onPrint}>
                        <span className='fa fa-print' aria-hidden='true' />
                    </button>
                    ) : undefined}
                    {(nonEmbedded && this.props.onShare) ? btnShare : undefined}
                    {nonEmbedded ? btnHelp : undefined}
                    {(nonEmbedded) ? (
                        <button type='button' className='btn btn-default'
                                title='Previous KCE View' onClick={this.props.onPreviousKCEView}>
                            <span className='fa fa-undo' aria-hidden='true' />
                        </button>
                    ) : undefined}
                    <button type='button' className='btn btn-default'
                            title='Visualize Key Concepts' onClick={this.onVisualizeWithKCE}>
                        <span className='fa fa-key' aria-hidden='true' /> Visualize with KCE
                    </button>
                    <div className="btn-group">
                        <label><span>Concept Count:</span></label>
                        <input type="number" name="concept_count" id="concept_count"
                            className={`${CLASS_NAME}__concept-count`} min="5" value={this.state.conceptCount}
                            onChange={this.onConceptCountChange}
                        />
                    </div>
                    <span className={`btn-group ${CLASS_NAME}__language-selector`}>
                        {nonEmbedded ? <label><span>Ontology Language:</span></label> : undefined}
                        <select defaultValue='en' onChange={this.onChangeLanguage}>
                            <option value='en'>English</option>
                            <option value='ru'>Russian</option>
                        </select>
                    </span>
                    <span className={`btn-group ${CLASS_NAME}__regime-selector`}>
                        {nonEmbedded ? <label><span>Regime</span></label> : undefined}
                        <select id="regime" ref={(regime) => {this.regime = regime;}} defaultValue= "class" onChange={this.onChangeRegime}>
                            <option value='class'>Extract classes</option>
                            <option value='individual'>Extract individuals</option>
                        </select>
                    </span>
                </div>
                <a href='#' ref={link => { this.downloadImageLink = link; }}
                   style={{display: 'none', visibility: 'collapse'}}/>
            </div>
        );
    }
}

export default EditorToolbar;
