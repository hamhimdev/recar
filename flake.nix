{
  description = "Recar - A Discord client for Linux";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    vencord-src = {
      url = "github:Vendicated/Vencord";
      flake = false;
    };
    equicord-src = {
      url = "github:Equicord/Equicord";
      flake = false;
    };
  };
  outputs = { self, nixpkgs, flake-utils, vencord-src, equicord-src }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib = nixpkgs.lib;
        
        recar = pkgs.stdenv.mkDerivation rec {
          pname = "recar";
          version = "1.0.1";
          
          src = pkgs.symlinkJoin {
            name = "recar-src-combined";
            paths = [
              (pkgs.runCommand "recar-src" { } ''
                mkdir -p $out
                cp -r ${./.}/* $out/
                chmod -R +w $out
                rm -rf $out/vencord $out/equicord
                cp -r ${vencord-src} $out/vencord
                cp -r ${equicord-src} $out/equicord
                chmod -R +w $out/vencord $out/equicord
              '')
            ];
          };

          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.pnpmConfigHook
            pkgs.makeWrapper
            pkgs.pnpm
          ];

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit pname version src;
            hash = "sha256-CRiyTxPfCr84c3NMznruT6UNhKW37kn+zm+NsZMszjg=";
            fetcherVersion = 3;
          };
          buildPhase = ''
            runHook preBuild
            
            pnpm exec tailwindcss -i ./src/input.css -o ./src/tailwind.css --minify
            
            echo "Building modules..."
            pnpm build:mods
            
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            
            mkdir -p $out/share/recar
            cp -r src package.json $out/share/recar/
            
            cp -r node_modules $out/share/recar/
            
            if [ -d "equicord/dist" ]; then
              mkdir -p $out/share/recar/equicord
              cp -r equicord/dist $out/share/recar/equicord/
            fi
            if [ -d "vencord/dist" ]; then
              mkdir -p $out/share/recar/vencord
              cp -r vencord/dist $out/share/recar/vencord/
            fi
            
            mkdir -p $out/bin
            makeWrapper ${pkgs.electron}/bin/electron $out/bin/recar \
              --add-flags "$out/share/recar/src/main.js" \
              --set NODE_ENV production \
              --prefix PATH : ${lib.makeBinPath [ pkgs.nodejs ]} \
              --add-flags "--no-sandbox"
            
            mkdir -p $out/share/applications
            cat > $out/share/applications/recar.desktop <<EOF
[Desktop Entry]
Name=Recar
Comment=A Discord client for Linux
Exec=recar
Icon=recar
Type=Application
Categories=Network;InstantMessaging;
Terminal=false
StartupWMClass=recar
EOF
            
            mkdir -p $out/share/icons/hicolor/256x256/apps
            if [ -f "src/assets/img/recar.png" ]; then
              cp src/assets/img/recar.png $out/share/icons/hicolor/256x256/apps/recar.png
            fi
            
            runHook postInstall
          '';
          meta = with lib; {
            description = "A Discord client for Linux";
            homepage = "https://cutely.strangled.net/recar";
            license = licenses.mit;
            platforms = platforms.linux;
            maintainers = ["hamhim"];
            mainProgram = "recar";
          };
        };
      in
      {
        packages = {
          recar = recar;
          default = recar;
        };
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs
            pkgs.pnpm
            pkgs.electron
          ];
        };
      }
    );
}