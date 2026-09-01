import React from "react";
import {TTComponent} from "../../TTComponent";
import {offScopeColorsChanged, onScopeColorsChanged, scopeColors} from "./ScopeColors";

export abstract class CanvasComponent<Props, State> extends TTComponent<Props, State> {
    private readonly canvasRef: React.RefObject<HTMLCanvasElement>;
    private readonly divRef: React.RefObject<HTMLDivElement>;
    private readonly resizeObserver: ResizeObserver;
    private readonly colorListener = () => this.refresh();

    public constructor(props: any) {
        super(props);
        this.canvasRef = React.createRef();
        this.divRef = React.createRef();
        this.resizeObserver = new ResizeObserver(() => this.refresh());
    }

    public render(): React.ReactNode {
        // Positioned so a subclass's overlay can be placed against the canvas; with no offsets of
        // its own this does not affect layout.
        return <div
            ref={this.divRef}
            style={{position: 'relative'}}
            onMouseMove={(ev) => this.onCanvasMouseMove(ev)}
            onMouseLeave={() => this.onCanvasMouseLeave()}
        >
            <canvas ref={this.canvasRef} className={'tt-canvas'}/>
            {this.renderOverlay()}
        </div>;
    }

    /** Canvas-relative pixel position of a mouse event, independent of any CSS scaling. */
    protected canvasPosition(ev: React.MouseEvent): {x: number, y: number} | undefined {
        const canvas = this.canvasRef.current;
        if (!canvas) {
            return undefined;
        }
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            return undefined;
        }
        return {
            x: (ev.clientX - rect.left) * (canvas.width / rect.width),
            y: (ev.clientY - rect.top) * (canvas.height / rect.height),
        };
    }

    protected canvasSize(): {width: number, height: number} | undefined {
        const canvas = this.canvasRef.current;
        return canvas ? {height: canvas.height, width: canvas.width} : undefined;
    }

    // Hooks for subclasses that want to react to the pointer; no-ops by default so the other
    // canvases behave exactly as before.
    protected onCanvasMouseMove(ev: React.MouseEvent) {}

    protected onCanvasMouseLeave() {}

    protected renderOverlay(): React.ReactNode {
        return undefined;
    }

    public componentDidMount() {
        this.resizeObserver.observe(this.canvasRef.current);
        onScopeColorsChanged(this.colorListener);
        this.refresh();
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        this.resizeObserver.unobserve(this.canvasRef.current);
        offScopeColorsChanged(this.colorListener);
    }

    public componentDidUpdate(prevProps: Props) {
        this.refresh();
    }

    protected abstract draw(ctx: CanvasRenderingContext2D, width: number, height: number);

    private refresh() {
        const canvas = this.canvasRef.current;
        const div = this.divRef.current;
        const ctx = canvas && canvas.getContext('2d');
        if (!canvas || !div || !ctx) {
            return;
        }
        canvas.height = div.offsetHeight;
        canvas.width = div.offsetWidth;
        ctx.fillStyle = scopeColors.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        this.draw(ctx, canvas.width, canvas.height);
    }
}
