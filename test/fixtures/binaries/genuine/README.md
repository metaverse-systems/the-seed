# Genuine Mac program samples

Byte-for-byte copies of the samples built by a real linker in libthe-seed/tests/fixtures (see PROVENANCE.md there). They are signed by the tests only after being copied to a temporary folder. SHA-256 values (equal to libthe-seed/tests/fixtures/SHA256SUMS):

    38b903d98a75ec65a3b0918ac29bf9fedb8263715e62439d023f6e5fb17f2a9c  tiny-macho-arm64
    cea933550c3e33e1ad699905e2852d8d01749267b2e776e5c25af6c975357a3c  tiny-macho-arm64-adhoc
    cb8ee911be4afa0306932fd17c30a158db637fc1ecdc328aa30f12d05a125651  tiny-macho-universal
    a401268d22e325244565aa4dc82e05228f2129b7e5837f8696db4041f4d1a376  tiny-macho-universal-adhoc
    6bd337c24619398dcb5f423fb0618444a8fba2fbc98fdd392f36f7bbf77f1929  tiny-macho-x86_64
    85972bee45f12308d38e47ea61b3c826573d11f3308205b880aee5334ee1a153  tiny-macho-x86_64-adhoc
    fdb73e077dc3a3efa2e6d3b883847a2d8c75c68cc4f7da7924640d8c48fd1d92  tiny-macho-x86_64-nospace

# Genuine and synthetic installer samples

Byte-for-byte copies of the installer samples in libthe-seed/tests/fixtures (see PROVENANCE.md there for the tool, version and command of each). They are signed by the tests only after being copied to a temporary folder. SHA-256 values (equal to the `sample` lines in msi-reference.txt):

    a5cb0a68f24041a3e5e2af0d70d9b06dbb1c55c4b1b17024378b0063affd92fc  tiny.msi
    1e921291df151d47bdc6a9762be493f832de2dcf5bd74283319b4ec26be44ca5  tiny-v4.msi
    2c646c8a188c25fa2a99e3f3a527939aac51c751fc7b669a9e49ae9297d06b4d  tiny-osslsig-small.msi
    b1deb046b4d7d882ad3fad88010c2931cf7558daa793dca3bad11ebd8c52a2ce  tiny-osslsig-large.msi
    28b76359e6caffe8d710f57ff6ea2aa0c07158f5d795ff48333d8dcd2db59ce8  tiny-osslsig-dse.msi
    28ba0837019eeddbfaa43ce3543809b93f69b4b841c90a70e856234494fb7bc8  nested.msi
    21d3a34cebfb648edd04907be33a5b6c200502719c78a04519fa21c3ca20525d  legacy-the-seed-0.6.0.msi
    c24a30ba657640a024efd7c0f7d6044b66c51b9e3cf9dca37277a55a07fff793  msi-reference.txt

Where they come from:

* tiny.msi: built by wixl (msitools) from a one-file source. The unsigned base of the others.
* tiny-v4.msi, nested.msi: SYNTHETIC. Written by make_cfb.py in libthe-seed/tests/fixtures: the same content as tiny.msi in a version 4 container (4,096-byte sectors), and tiny.msi plus two nested storages with class identifiers.
* tiny-osslsig-small.msi, tiny-osslsig-large.msi, tiny-osslsig-dse.msi: tiny.msi signed by osslsigncode 2.14 with a throw-away certificate (a 1,444-byte signature, a 7,473-byte signature, and a signature that also has the extended signature stream).
* legacy-the-seed-0.6.0.msi: LEGACY. tiny.msi as signed by libthe-seed 0.6.0, whose signature entry is not reachable by searching. osslsigncode cannot read it.
* msi-reference.txt: the values osslsigncode reported for each sample (package fingerprint, signature sizes, entry counts, digests held in the signatures). test/helpers/CfbChecker.ts reads it.
