import * as Y from "yjs";
function normalizeAttributes(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return { ...value };
}
function normalizeDelta(value) {
    if (typeof value === "string") {
        return { insert: value };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const insert = value.insert;
    if (typeof insert !== "string") {
        return null;
    }
    const attributes = normalizeAttributes(value.attributes);
    return attributes ? { insert, attributes } : { insert };
}
export function richTextValueToDeltas(value) {
    if (value instanceof Y.Text) {
        return value
            .toDelta()
            .map((delta) => normalizeDelta(delta))
            .filter((delta) => delta !== null);
    }
    if (typeof value === "string") {
        return [{ insert: value }];
    }
    if (Array.isArray(value)) {
        return value.map(normalizeDelta).filter((delta) => delta !== null);
    }
    const delta = normalizeDelta(value);
    return delta ? [delta] : null;
}
export function richTextValueToString(value) {
    const deltas = richTextValueToDeltas(value);
    return deltas?.map(delta => delta.insert).join("") ?? "";
}
