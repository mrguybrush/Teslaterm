import 'justgage/dist/justgage';
import React from "react";
import {MeterConfig} from "../../../common/IPCConstantsToRenderer";

import {DarkModeContext} from "../../DarkModeContext";
import {TTComponent} from "../../TTComponent";

export interface GaugeProps {
    value: number;
    config: MeterConfig;
}

const DARK_GAUGE_PROPS = {
    gaugeColor: '#575757',
    labelFontColor: 'white',
    valueFontColor: 'white',
};

export class Gauge extends TTComponent<GaugeProps, {}> {
    public static contextType = DarkModeContext;

    private static nextId: number = 0;
    public declare context: React.ContextType<typeof DarkModeContext>;
    private readonly id: string;
    private gauge?: JustGage;
    private readonly ref: React.RefObject<HTMLDivElement>;
    private observer?: ResizeObserver;

    public constructor(props: any) {
        super(props);
        this.id = "tt-gauge-" + Gauge.nextId;
        ++Gauge.nextId;
        this.ref = React.createRef();
    }

    public componentDidMount() {
        this.reInit();
        if (this.ref.current) {
            this.observer = new ResizeObserver( () => this.reInit());
            this.observer.observe(this.ref.current);
        }
    }

    public componentDidUpdate() {
        if (!this.ref.current || this.ref.current.offsetHeight < 10 || this.ref.current.offsetWidth < 10) {
            return;
        }
        if (this.gauge) {
            const newConfig = this.props.config;
            const oldConfig = this.gauge.config;
            const configChanged = newConfig.min !== oldConfig.min ||
                newConfig.max !== oldConfig.max ||
                newConfig.name !== oldConfig.label;
            if (configChanged) {
                this.gauge.refresh(
                    this.props.value, this.props.config.max, this.props.config.min, this.props.config.name,
                );
            } else if (this.props.value !== this.gauge.config.value) {
                this.gauge.refresh(this.props.value);
            }
        }
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        // disconnect() (not unobserve()) guarantees no already-queued callback can still fire
        // after this component is gone - a stale one calling reInit() post-unmount would create
        // a second JustGage instance fighting the destroyed one over the same DOM id.
        if (this.observer) {
            this.observer.disconnect();
            this.observer = undefined;
        }
        if (this.gauge) {
            (this.gauge as any).destroy();
            this.gauge = undefined;
        }
    }

    public render() {
        return <div id={this.id} className={'tt-gauge'} ref={this.ref}/>;
    }

    private reInit() {
        // The ResizeObserver also fires while the container is still mid-reflow at zero size
        // (e.g. right when a new coil's column gets added to the telemetry grid) - creating a
        // JustGage against a zero-size element leaves its internal Raphael state incomplete,
        // and a later destroy()/refresh() against that broken instance throws. Skip and wait for
        // the next observer callback, which fires again once the container has a real size.
        if (!this.ref.current || this.ref.current.offsetHeight < 10 || this.ref.current.offsetWidth < 10) {
            return;
        }
        if (this.gauge) {
            (this.gauge as any).destroy();
        }
        this.gauge = new JustGage({
            id: this.id,
            label: this.props.config.name,
            max: this.props.config.max,
            min: this.props.config.min,
            decimals: 2,
            refreshAnimationTime: 0,
            startAnimationTime: 0,
            value: this.props.value,
            ...(this.context.valueOf() ? DARK_GAUGE_PROPS : {}),
        });
    }
}
