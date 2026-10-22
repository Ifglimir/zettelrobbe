const crypto = require('crypto');
const config = require('../config/config');
const documentModel = require('../models/document');
const paperlessService = require('./paperlessService');

/**
 * Below this many characters a text is too generic to stand for one document:
 * two one-line receipts would otherwise count as the same text.
 */
const MIN_FINGERPRINT_LENGTH = 200;

/**
 * Skip rules decide, before any OCR or AI call, that a document is not worth
 * processing: too many pages, a title on the skip list, or the same text as a
 * document already on the ignored list. A match puts the document on the
 * ignored list with the rule as its reason, so it is visible and reversible.
 * A document taken off that list by hand is exempt from the rules.
 */
class SkipRuleService {
  /**
   * Fingerprint of a document text: whitespace and case do not count, so the
   * same terms with a different line break still match.
   *
   * @param {string} content
   * @returns {string|null} sha256 hex, or null for a text too short to compare
   */
  fingerprint(content) {
    const normalized = String(content || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (normalized.length < MIN_FINGERPRINT_LENGTH) {
      return null;
    }
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * @param {{id: number, title?: string, original_file_name?: string, page_count?: number}} doc
   *   The full Paperless-ngx document.
   * @param {string} [content] The text Paperless-ngx recognised.
   * @returns {Promise<{reason: string, contentHash: string|null}|null>}
   */
  async evaluate(doc, content) {
    if (!doc || (await documentModel.isSkipRuleExempt(doc.id))) {
      return null;
    }

    const rules = config.getSkipRulesConfig();
    const contentHash = this.fingerprint(content);

    const pageCount = Number(doc.page_count);
    if (rules.maxPageCount > 0 && pageCount > rules.maxPageCount) {
      return {
        reason: `Page limit: ${pageCount} pages (max ${rules.maxPageCount})`,
        contentHash,
      };
    }

    const names = [doc.title, doc.original_file_name]
      .filter(Boolean)
      .map((name) => String(name).toLowerCase());
    const pattern = rules.titlePatterns.find((candidate) =>
      names.some((name) => name.includes(candidate.toLowerCase()))
    );
    if (pattern) {
      return { reason: `Title matches "${pattern}"`, contentHash };
    }

    if (rules.ignoreRepeatedContent && contentHash) {
      const original =
        await documentModel.findIgnoredByContentHash(contentHash);
      if (original && Number(original.document_id) !== Number(doc.id)) {
        return {
          reason: `Same text as #${original.document_id}`,
          contentHash,
        };
      }
    }

    return null;
  }

  /**
   * Evaluates the rules and, on a match, moves the document to the ignored
   * list.
   *
   * @returns {Promise<{reason: string, contentHash: string|null}|null>} the match
   */
  async apply(doc, content) {
    const match = await this.evaluate(doc, content);
    if (!match) {
      return null;
    }

    await documentModel.addIgnoredDocument(
      doc.id,
      doc.title || '',
      match.reason,
      match.contentHash
    );
    await documentModel.clearProcessingStatusByDocumentId(doc.id);
    console.info(
      `Document ${doc.id} skipped before OCR and AI and moved to the ignored list (${match.reason})`
    );
    return match;
  }

  /**
   * Stores the text fingerprint of documents put on the ignored list by hand,
   * so later copies are recognised. Fetches the text from Paperless-ngx one
   * document at a time; a failure only means that copy is not recognised.
   *
   * @param {Array<number>} documentIds
   */
  async rememberFingerprints(documentIds) {
    for (const documentId of documentIds) {
      try {
        const content = await paperlessService.getDocumentContent(documentId);
        const contentHash = this.fingerprint(content);
        if (contentHash) {
          await documentModel.setIgnoredContentHash(documentId, contentHash);
        }
      } catch (error) {
        console.warn(
          `Could not store the text fingerprint of ignored document ${documentId}: ${error.message}`
        );
      }
    }
  }
}

module.exports = new SkipRuleService();
