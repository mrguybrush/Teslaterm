import {DEFAULT_TRACE_COLORS} from "../../../common/ScopePalette";

export interface ScopeColors {
    background: string;
    gridLine: string;
    traceColors: string[];
    // Not a color, but shares the same "shared render-side config, synced from App.tsx" mechanism
    // as everything else here - width in pixels of the actual data trace line (not the grid).
    lineWidth: number;
}

// Re-exported so the existing imports from here keep working; the list itself lives in common
// because the stored UI config, which overrides it, is written by the main process.
export {DEFAULT_TRACE_COLORS};

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
