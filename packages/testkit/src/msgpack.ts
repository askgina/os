/**
 * A msgpack encoder written by someone else (`@msgpack/msgpack`), for tests that check the
 * signer's own minimal encoder byte for byte. Never imported by anything that runs in production.
 */
export { encode as referenceMsgpackEncode } from "@msgpack/msgpack";
