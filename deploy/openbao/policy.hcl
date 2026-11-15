# The least an askgina/os control plane needs from OpenBao Transit: wrap and unwrap data keys
# under one key, and read that key's versions. It cannot export, rotate, delete or configure the
# key. Replace "transit" and "os-kek" when OPENBAO_TRANSIT_MOUNT or OPENBAO_TRANSIT_KEY differ.
# Token lookup and renewal come from OpenBao's default policy.

path "transit/encrypt/os-kek" {
  capabilities = ["update"]
}

path "transit/decrypt/os-kek" {
  capabilities = ["update"]
}

path "transit/keys/os-kek" {
  capabilities = ["read"]
}
