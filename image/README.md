# Live image notes

## Non-interactive age passphrases

The exchange services use age's batchpass plugin mode. Require age 1.3 or
newer; Task 1 owns the archive pin and must keep it at or above that minimum.
The verified CLI version is age 1.3.2. The passphrase is supplied through
file descriptor 3 with `AGE_PASSPHRASE_FD=3`, and inherited
`AGE_PASSPHRASE` and `AGE_PASSPHRASE_WORK_FACTOR` variables are unset. For
example, the service opens descriptor 3 on the root keyring payload and runs:

```sh
exec 3< <(keyctl pipe "$key_id" || exit; printf '\n')
env -u AGE_PASSPHRASE -u AGE_PASSPHRASE_WORK_FACTOR \
  AGE_PASSPHRASE_FD=3 age -e -j batchpass <bundle.tar >bundle.age
exec 3<&-
```

Decryption uses the same descriptor contract with `age -d -j batchpass`.
Both operations work without a controlling terminal. Do not put the
passphrase in an argument, environment value, or temporary file. The default
scrypt stanza interoperates with Rust age 0.11.5.
