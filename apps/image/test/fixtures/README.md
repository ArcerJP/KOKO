# 合成HEIC試験素材

第三者の写真を使用せず、`../generate-fixture.mjs`が作る96×64の左右赤/青の画素をlibheifの`heif-enc -L`でHEVC/HEICへ符号化しました。人物・実位置情報はありません。blocks.heicは単一画像、multiple.heicは同じ画素を2枚含む拒否試験用です。実端末の写真ではありません。

2026-10-05にDockerfileのfixture-generator（Debian bookworm、libheif-examples 1.15.1-1+deb12u1）で生成。元画素と生成scriptが正本、binaryは通常CIをencoder導入なしで実行するため追跡します。encoder更新でbinaryは変わり得るため、再生成は差分・decode結果を確認して通常PRで扱います。

再生成時は既存fixtureを上書きせず、空の専用ディレクトリだけを`/fixtures`へ書込みmountし、通信を禁止して実行します。Dockerfileのfixture-generatorをbuildした後のcommand引数は、単一なら`test/generate-fixture.mjs /fixtures/blocks.heic`、複数なら`test/generate-fixture.mjs /fixtures/multiple.heic --multiple`です。実写真や秘密をこのディレクトリへ置きません。
