export interface ScopeColors {
    background: string;
    gridLine: string;
    traceColors: string[];
    // Not a color, but shares the same "shared render-side config, synced from App.tsx" mechanism
    // as everything else here - width in pixels of the actual data trace line (not the grid).
    lineWidth: number;
}

export const DEFAULT_TRACE_COLORS: string[] = [
    "#ff3b3b",
    "#ffb703",
    "#00d68f",
    "#0d7fc4",
    "#a64dd6",
];

export const DEFAULT_SCOPE_BACKGROUND = "#f0f0f0";
export const DEFAULT_SCOPE_GRID_LINE = "#bfbfbf";
export const DEFAULT_SCOPE_LINE_WIDTH = 2;

export let scopeColors: ScopeColors = {
    background: DEFAULT_SCOPE_BACKGROUND,
    gridLine: DEFAULT_SCOPE_GRID_LINE,
    lineWidth: DEFAULT_SCOPE_LINE_WIDTH,
    traceColors: DEFAULT_TRACE_COLORS,
};

type ScopeColorsListener = () => void;
const listeners: ScopeColorsListener[] = [];

export function onScopeColorsChanged(listener: ScopeColorsListener): ScopeColorsListener {
    listeners.push(listener);
    return listener;
}

export function offScopeColorsChanged(listener: ScopeColorsListener) {
    const index = listeners.indexOf(listener);
    if (index >= 0) {
        listeners.splice(index, 1);
    }
}

export function setScopeColors(newColors: Partial<ScopeColors>) {
    scopeColors = {...scopeColors, ...newColors};
    listeners.forEach((l) => l());
}
