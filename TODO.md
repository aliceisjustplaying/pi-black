# TODO

- [ ] **Cover `src/share-html.ts` with tests.** It is the only source file with no
      test. The blocker is that `exportShareHtml` deep-imports pi's own
      `dist/core/export-html/index.js` through `pathToFileURL`, so testing the
      function means mocking a dynamic import of a pi-internal path.

      The testable core is `idsByEntry`, which is pure and does the two-pass
      match: by `responseId` first, then the latest unused request with no
      `messageId` at or before the entry timestamp for error messages.
      Exporting it widens the module's surface; the alternative is keeping a
      parallel copy of the matcher in the test, which will drift. Prefer
      exporting.

      Worth covering, because a mismatch here silently mis-annotates a shared
      `/share-ant-pi` report rather than failing loudly.

      Also worth pinning: the exported `<` escaping in `idsScript`, which keeps
      session text from closing the injected `<script>` element.