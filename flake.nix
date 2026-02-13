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

          src = self;

          nativeBuildInputs = with pkgs; [
            nodejs
            pnpmConfigHook
            makeWrapper
            pnpm
          ];

          buildInputs = with pkgs; [
            electron
          ];

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit pname version src;
            hash = "sha256-9rHqfafCKtuwAAj3/N2p/em4ddlWQhM07RhQJR9VTYg="; 
            fetcherVersion = 3;
          };

          buildPhase = ''
            runHook preBuild

            # pnpm.configHook handles PNPM_HOME and store-dir automatically.
            # We just need to trigger the install and build.
            
            pnpm install --frozen-lockfile --offline
            
            # Build the internal mods and tailwind
            pnpm run install:mods --offline
            pnpm run build:mods
            pnpm run build:css

            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            mkdir -p $out/share/recar
            mkdir -p $out/bin

            # Copy relevant files (excluding dev junk)
            cp -r src equicord vencord package.json node_modules $out/share/recar/

            # Create wrapper script using Nixpkgs Electron
            makeWrapper ${pkgs.electron}/bin/electron $out/bin/recar \
              --add-flags "$out/share/recar/src/main.js" \
              --set ELECTRON_IS_DEV 0 \
              --set NODE_ENV production

            # Desktop Item
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

            # Icon
            mkdir -p $out/share/icons/hicolor/256x256/apps
            if [ -f "src/img/recar.png" ]; then
              cp src/img/recar.png $out/share/icons/hicolor/256x256/apps/recar.png
            fi

            runHook postInstall
          '';
        };
      }
    );
}