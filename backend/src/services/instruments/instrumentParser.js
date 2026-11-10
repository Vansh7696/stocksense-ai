import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { AppError } from '../../middleware/errorHandler.js';

const gunzipAsync = promisify(zlib.gunzip);

export class InstrumentParser {
  /**
   * Decompresses gzipped bytes and parses the resulting JSON array.
   *
   * @param {Buffer|Uint8Array} compressedBuffer - Gzipped data buffer
   * @returns {Promise<Array<Object>>} Parsed array of instrument records
   */
  async parse(compressedBuffer) {
    if (!compressedBuffer || compressedBuffer.length === 0) {
      throw new AppError(
        'Cannot parse instrument master: input buffer is empty or null.',
        422,
        'EMPTY_DATA'
      );
    }

    // 1. Decompression
    let decompressedString = '';
    try {
      const decompressedBuffer = await gunzipAsync(compressedBuffer);
      decompressedString = decompressedBuffer.toString('utf-8').trim();
    } catch (err) {
      throw new AppError(
        `Failed to decompress instrument archive: ${err.message}`,
        422,
        'CORRUPT_ARCHIVE',
        { originalError: err.message }
      );
    }

    if (!decompressedString || decompressedString.length === 0) {
      throw new AppError(
        'Decompressed instrument file content is empty.',
        422,
        'EMPTY_DATA'
      );
    }

    // 2. JSON Deserialization
    let records = null;
    try {
      records = JSON.parse(decompressedString);
    } catch (err) {
      throw new AppError(
        `Failed to parse decompressed instrument JSON: ${err.message}`,
        422,
        'INVALID_JSON',
        { originalError: err.message }
      );
    }

    if (!Array.isArray(records)) {
      throw new AppError(
        'Invalid instrument master format: expected a top-level JSON array of records.',
        422,
        'INVALID_FORMAT'
      );
    }

    return records;
  }
}

export default new InstrumentParser();
