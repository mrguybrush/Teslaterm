import React from "react";
import {Button} from "react-bootstrap";
import DropdownMenu from "react-bootstrap/DropdownMenu";
import {TTComponent} from "./TTComponent";

export interface DropdownProps {
    children: React.JSX.Element[];
    title: string;
}

interface DropdownState {
    shown: boolean;
}

export class TTDropdown extends TTComponent<DropdownProps, DropdownState> {
    private readonly containerRef: React.RefObject<HTMLDivElement>;
    private readonly handleOutsideClick = (ev: MouseEvent) => {
        if (
            this.state.shown &&
            this.containerRef.current &&
            !this.containerRef.current.contains(ev.target as Node)
        ) {
            this.setState({shown: false});
        }
    };

    constructor(props) {
        super(props);
        this.state = {shown: false};
        this.containerRef = React.createRef();
    }

    public componentDidMount() {
        document.addEventListener('mousedown', this.handleOutsideClick);
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        document.removeEventListener('mousedown', this.handleOutsideClick);
    }

    render() {
        return <div className={'dropdown' + (this.state.shown ? ' show' : '')} ref={this.containerRef}>
            <Button
                onClick={() => this.setState(oldState => ({shown: !oldState.shown}))}
                className={'dropdown-toggle'}
                aria-expanded={this.state.shown}
            >
                {this.props.title}
            </Button>
            <DropdownMenu
                show={this.state.shown}
                onClick={() => this.setState({shown: false})}
            >
                {this.props.children}
            </DropdownMenu>
        </div>;
    }
}
