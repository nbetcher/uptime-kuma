/**
 * Database drivers include rendered SQL (image bytes and URL passwords)
 * in error.message. Only expose a stable driver code outside storage.
 * @param {Error} error Database failure
 * @returns {string} Safe description
 */
function dbErrorMessage(error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error?.code || "") ? ` (${error.code})` : "";
    return `Stream image database operation failed${code}`;
}

module.exports = { dbErrorMessage };
