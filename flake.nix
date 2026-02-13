{
  description = "Recar - A Discord client for Linux";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        packages.default = pkgs.stdenv.mkDerivation rec {
          pname = "recar";
          version = "1.0.0";

          src = ./.;

          nativeBuildInputs = with pkgs; [
            nodejs
            pnpmConfigHook
            makeWrapper
          ];

          buildInputs = with pkgs; [
            electron
          ];

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit pname version src;
            hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; # Replace with actual hash after first build
            fetcherVersion = 3;
          };

          buildPhase = ''
            runHook preBuild

            export HOME=$TMPDIR
            export PNPM_HOME="$HOME/.pnpm"
            export PATH="$PNPM_HOME:$PATH"

            # Install dependencies
            pnpm config set store-dir $TMPDIR/pnpm-store
            pnpm install --frozen-lockfile --offline

            # Initialize and update submodules
            git submodule update --init --recursive || true

            # Install and build mods
            pnpm install:mods
            pnpm build:mods

            # Build CSS
            pnpm build:css

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out/share/recar
            mkdir -p $out/bin

            # Copy application files
            cp -r src $out/share/recar/
            cp -r equicord $out/share/recar/
            cp -r vencord $out/share/recar/
            cp package.json $out/share/recar/
            cp -r node_modules $out/share/recar/

            # Create wrapper script
            makeWrapper ${pkgs.electron}/bin/electron $out/bin/recar \
              --add-flags "$out/share/recar/src/main.js" \
              --set ELECTRON_IS_DEV 0

            # Install desktop file
            mkdir -p $out/share/applications
            cat > $out/share/applications/recar.desktop <<EOF
            [Desktop Entry]
            Name=Recar
            Comment=A Discord client for Linux
            Exec=$out/bin/recar
            Icon=recar
            Type=Application
            Categories=Network;InstantMessaging;
            EOF

            # Install icon
            mkdir -p $out/share/icons/hicolor/256x256/apps
            cp src/img/recar.png $out/share/icons/hicolor/256x256/apps/recar.png

            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "A Discord client for Linux";
            homepage = "https://codeberg.org/hamhim/recar";
            license = licenses.mit;
            maintainers = [ ];
            platforms = platforms.linux;
            mainProgram = "recar";
          };
        };
      }
    );
}
