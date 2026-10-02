# TODO

- [x] **Cover `src/share-html.ts` with tests.** Done in `test/share-html.test.ts`:
      `idsByEntry` is exported and its two-pass matching is pinned — by message
      id, then by turn-scoped failed request. The provider guard, the
      requirement that the candidate actually failed, and the turn floor are
      each verified by removing that one constraint.

- [ ] **Pin the `idsScript` escaping.** `idsScript` is still unexported and
      untested. Worth covering that session text cannot close the injected
      `<script>` element, and that request/message ids and stop reasons stay
      escaped before reaching `innerHTML`. Reviewers have probed this by hand
      and found no breakout, but nothing prevents a regression.