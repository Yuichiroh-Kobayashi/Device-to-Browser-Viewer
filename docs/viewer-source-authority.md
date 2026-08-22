# Viewer source authority

1. Device-to-Browser-Viewer base/regression lineage:
   `bef258e16513bd7e12cc15198d97af3203c70f91`

2. Contest physical runtime validation anchor:
   `80a9cd308cb3c6c5a1ccc27241cd645803675921`

3. P2-SP product source:
   `src/product/p2-sp/`

4. Recovered exact builder:
   `tools/p2-builder/p2-builder.py`

5. P2-SP recovery generation:
   `20260814-1407-g1-ms-r2`

6. Accepted historical P2-SP bundle identity:
   `9053e0a206070c1b5c137cd8f563a58e335addac67a737a26d45e62853df52ce`

7. Historical `viewer_source_commit` ambiguity:
   the historical Git Viewer commit represented the base/regression Viewer
   lineage, not the complete P2-SP product source. This commit restores that
   missing product-source lineage into Git.

8. `src/protocol/d2b-reference` remains unchanged and follows D2B frozen
   authority: `5411ba59a12882345d32218eda367bd6ba35ef5d`

9. This commit does not fix the `deployment-context.js` WebCrypto/secure-context
   problem.

10. That behavior change is a separate, later change (not part of this commit).

11. This commit does not rebuild the accepted bundle.

12. Git-managed-source reproduction of the accepted bundle from these files is
    not yet run. It is a dedicated, later verification step.

13. No Windows Relay becomes production architecture as a result of this change.

14. No machine-specific absolute paths appear in this document or in
    `docs/provenance/p2-sp-source-manifest.tsv`.
