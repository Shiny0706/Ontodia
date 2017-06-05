import * as ReactDOM from 'react-dom';
import * as React from 'react';
export interface MessageDialogOptions {
    parentNode: HTMLElement;
    title: string;
    message: string;
    onClose: () => void;
}

export class MessageDialog {
    private container: HTMLElement;
    private parentNode: HTMLElement;

    constructor(private options: MessageDialogOptions) {
        this.container = document.createElement('div');
        this.container.className = 'ontodia__modal-wrapper';
        this.parentNode = this.options.parentNode;
        this.parentNode.appendChild(this.container);
        this.render();
    }

    private render() {
        ReactDOM.render(React.createElement(MessageDialogMarkup, {
            title: this.options.title,
            message: this.options.message,
            onBtnCloseClicked: () => {
                this.options.onClose();
            },
        }), this.container);
    };

    remove() {
        ReactDOM.unmountComponentAtNode(this.container);
        this.parentNode.removeChild(this.container);
    }
}

export interface MessageDialogMarkupProps {
    title: string;
    message: string;
    onBtnCloseClicked: () => void;
}

export class MessageDialogMarkup extends React.Component<MessageDialogMarkupProps, {}> {

    constructor(props: MessageDialogMarkupProps) {
        super(props);
    }

    render() {
        var modalContentStyle = {
            position: 'absolute',
            top: '50%',
            left: '30%',
            marginTop: '100px',
            width: '400px'
        };
        return (
            <div className='modal-dialog'>
                <div className='modal-content' style={modalContentStyle}>
                    <div className='modal-header'>
                        <h4 className="modal-title" id="modal-title">{this.props.title}</h4>
                    </div>
                    <div className='modal-body'>
                        <p>{this.props.message}</p>
                    </div>
                    <div className='modal-footer'>
                        <button type='button' className='btn btn-primary' onClick={this.props.onBtnCloseClicked}>Close</button>
                    </div>
                </div>
            </div>
        );
    }

}
