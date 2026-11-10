/**
 * JSON Serialization Utilities
 *
 * Provides explicit, prototype-safe JSON serialization for BigInt and market data
 * without modifying JavaScript built-in prototypes (such as BigInt.prototype.toJSON).
 */

/**
 * Express / JSON.stringify replacer function that converts BigInt values
 * into exact decimal strings while preserving all other types.
 *
 * @param {string} key - Object key or index
 * @param {any} value - Property value
 * @returns {any} Converted value or original value
 */
export function bigIntJsonReplacer(key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Explicit safe JSON serializer that converts BigInt values to exact decimal strings
 * without modifying BigInt.prototype.
 *
 * @param {any} value - The object or value to stringify
 * @param {Function|Array} [replacer=null] - Optional additional replacer function
 * @param {number|string} [space=null] - Indentation spaces
 * @returns {string} Serialized JSON string
 */
export function safeJsonStringify(value, replacer = null, space = null) {
  if (typeof replacer === 'function') {
    return JSON.stringify(
      value,
      (key, val) => {
        const customReplaced = replacer(key, val);
        return typeof customReplaced === 'bigint' ? customReplaced.toString() : customReplaced;
      },
      space
    );
  }
  return JSON.stringify(value, bigIntJsonReplacer, space);
}
