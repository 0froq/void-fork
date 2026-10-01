import { defineCanonicalJsonTests } from '../../../../test/canonical-json-contract.ts';
import { canonicalJson } from '../../src/index.ts';

defineCanonicalJsonTests(canonicalJson);
