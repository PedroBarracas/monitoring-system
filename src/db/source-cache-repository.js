function createSourceCacheRepository(db) {
  const selectStmt = db.prepare('SELECT * FROM source_cache WHERE source_url = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO source_cache (source_url, etag, last_modified, last_full_fetch_at, content_hash, had_304_since_last)
    VALUES (?, ?, ?, datetime('now'), ?, 0)
    ON CONFLICT(source_url) DO UPDATE SET
      etag = excluded.etag,
      last_modified = excluded.last_modified,
      last_full_fetch_at = datetime('now'),
      content_hash = excluded.content_hash,
      had_304_since_last = 0
  `);
  // Used on 304 hits — refresh the validators (server may send a new ETag on
  // 304 if the resource is the same but its metadata moved) without resetting
  // the full-fetch timestamp. Keeps the TTL ticking against the last full GET,
  // not the last conditional check. Also sets had_304_since_last=1 so the
  // next full GET can run the lie-detection comparison.
  const refreshValidatorsStmt = db.prepare(`
    UPDATE source_cache
    SET etag = ?, last_modified = ?, had_304_since_last = 1
    WHERE source_url = ?
  `);
  // Sets conditional_disabled=1 — the source has been caught serving phantom
  // 304s on a body that actually changed. From now on, every fetch goes
  // unconditionally (plain GET) to avoid further deception.
  const disableConditionalStmt = db.prepare(`
    UPDATE source_cache
    SET conditional_disabled = 1
    WHERE source_url = ?
  `);

  return {
    get(sourceUrl) {
      return selectStmt.get(sourceUrl) || null;
    },

    // Called after a 200: store fresh validators, reset the TTL clock, and
    // record the body's content hash for future lie-detection comparisons.
    upsertFullFetch(sourceUrl, etag, lastModified, contentHash) {
      upsertStmt.run(sourceUrl, etag || null, lastModified || null, contentHash || null);
    },

    // Called after a 304: server may have rotated the validators while serving
    // the same body — keep them current. Also records that a 304 happened in
    // this TTL window, so when the next full GET runs we can compare hashes
    // and catch a lying server.
    refreshValidators(sourceUrl, etag, lastModified) {
      refreshValidatorsStmt.run(etag || null, lastModified || null, sourceUrl);
    },

    // Caught a lying 304. Mark this source permanently — every future fetch
    // skips the conditional path.
    disableConditional(sourceUrl) {
      disableConditionalStmt.run(sourceUrl);
    },
  };
}

module.exports = { createSourceCacheRepository };
