// Replacement for apache-arrow/builder/valid.mjs that avoids new Function().
// Semantically equivalent: uses a Set + NaN guard instead of a dynamic switch.
export function createIsValidFunction(nullValues) {
    if (!nullValues || nullValues.length <= 0) {
        return function isValid(value) { return true; };
    }
    const noNaNs = nullValues.filter((x) => x === x);
    const hasNaN = nullValues.length !== noNaNs.length;
    const nullSet = new Set(noNaNs);
    return function isValid(x) {
        if (hasNaN && x !== x) return false;
        return !nullSet.has(x);
    };
}
