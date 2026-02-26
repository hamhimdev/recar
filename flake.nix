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
          version = "1.1.4";
          
          src = pkgs.runCommand "recar-src" { } ''
            mkdir -p $out
            cp -r ${./.}/* $out/
            chmod -R +w $out
            rm -rf $out/vencord $out/equicord
            cp -r ${vencord-src} $out/vencord
            cp -r ${equicord-src} $out/equicord
            chmod -R +w $out/vencord $out/equicord
          '';

          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.pnpmConfigHook
            pkgs.makeWrapper
            pkgs.pnpm
            pkgs.git
          ];

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit pname version src;
            hash = "sha256-MYffu4C5KxtaYlXrq0JtmXhSjusZXVvP/nuFcurOibU=";
            fetcherVersion = 3;
          };

          unpackPhase = ''
            cp -r $src/. .
            chmod -R +w .
          '';

          preBuild = ''
            git init
            git remote add origin https://github.com/hamhimdev/recar
            
            mkdir -p equicord/.git
            pushd equicord
            git init
            git remote add origin https://github.com/Equicord/Equicord
            popd

            mkdir -p vencord/.git
            pushd vencord
            git init
            git remote add origin https://github.com/Vendicated/Vencord
            popd
            
            #git add .
            #git -c user.email="nix@build" -c user.name="Nix" commit -m "nix-build-dummy"
          '';

          buildPhase = ''
            runHook preBuild
            
            export VENCORD_REMOTE="Vendicated/Vencord"
            export EQUICORD_REMOTE="Equicord/Equicord"
            
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
Categories=Network;InstantMessaging;Chat;
Terminal=false
StartupWMClass=Recar
EOF
            
            mkdir -p $out/share/icons/hicolor/256x256/apps
            if [ -f "src/assets/img/recar.png" ]; then
              cp src/assets/img/recar.png $out/share/icons/hicolor/256x256/apps/recar.png
            fi
            
            runHook postInstall
          '';
          meta = with lib; {
            description = "A Discord client for Linux";
            homepage = "https://recar.loxodrome.app";
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