# Earlier-form signed samples

Three files signed by the-seed at revision dc1d1ca (version 1.12.0), before signature containers were built in the standard form, plus the certificate that signed them. The tests use them to check that files signed by the earlier tool are still read, that the verifier reports them as trusted when their certificate is supplied, and that signing them again replaces the signature.

How they were made: the tool built at dc1d1ca, with its own addon, in a detached copy of the source outside this repository. A fresh configuration directory held one scope, `@earlier`. `createCert` with a validity of 36,500 days was called with a fresh configuration until the 16 random serial bytes began with a byte of 0x80 or more (1 attempt), so the certificate's serial is written in 17 bytes starting 00 and the earlier tool wrote it without that byte. Scratch copies of the unsigned originals were then signed with the scope. The private key and the configuration directory were deleted and are not part of the repository.

Certificate `cert.pem`:

    serial       95340178FD664E386E7A33A15E870BB9
    sha256       A8:C2:83:B0:F7:E1:8F:DC:AB:C1:0C:F7:A0:F8:38:BF:D7:86:86:0F:39:2C:47:38:9C:93:61:87:5E:B0:A2:84
    subject      CN=Earlier Form, E=earlier@example.com, O=@earlier

What the earlier form looks like to other tools: osslsigncode (2.14) reports decoding errors for the program's `SpcLink` and `Failed` for `tiny.exe`; for the installer it cannot find the signer's certificate. In the Mac program's containers `openssl cms -cmsout -print` shows no signed attributes and prints the serial as a negative number.

SHA-256 of each file and of the unsigned original it was made from:

    77e60e094069907b7d005c06b568437deef2ab970913d21c30c75a6ffd733e2a  tiny.exe (original ae32edcb121a8d06f05954a6554e05167cb687c39099e68720ffa77672921ce0, test/fixtures/binaries/tiny.exe)
    f18e7fc2dfe3b53aa2008a52f4325d40c0129d08188c1010528e8183785b42e4  tiny.msi (original a5cb0a68f24041a3e5e2af0d70d9b06dbb1c55c4b1b17024378b0063affd92fc, test/fixtures/binaries/genuine/tiny.msi)
    fee01e9525a606d00d21e434e60ed7d7a5a90914796c3a3293bf628aa653fdb7  tiny-macho-universal (original cb8ee911be4afa0306932fd17c30a158db637fc1ecdc328aa30f12d05a125651, test/fixtures/binaries/genuine/tiny-macho-universal)
    5dd87ada6a5079dc142f0ba0b84a316286c8fc743dc3dc1f7478ffdf18ae7b96  cert.pem
