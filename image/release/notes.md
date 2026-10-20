AIS Live image for x86_64, with legacy BIOS and UEFI boot support.

The bundled herdr project is licensed under Apache-2.0. Source: https://github.com/herdrdev/herdr

From the downloaded-assets directory, verify the checksum manifest against the trusted published key before checking the image: `minisign -Vm SHA256SUMS -p path/to/checkout/image/release/minisign.pub && sha256sum -c SHA256SUMS`.
