# FX rate fixtures

Hand-written files in the exact published formats, with illustrative rates (not downloaded data):

- `eurofxref-hist-90d.xml` and `eurofxref-hist.xml`: ECB euro reference rates
  (`https://www.ecb.europa.eu/stats/eurofxref/`). They include an unknown currency and a malformed
  rate that the parser must drop.
- `oxr-latest.json`: an Open Exchange Rates `latest.json` response (USD base). It includes an unknown
  currency and a non-numeric rate.

Replacing them with recorded downloads would also check the parser against real files.
