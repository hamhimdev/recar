{
  description = "Recar - A Discord client for Linux";
  
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib = nixpkgs.lib;
        
        recar = pkgs.stdenv.mkDerivation rec {
          pname = "recar";
          version = "1.0.1";
          src = ./.;
          
          nativeBuildInputs = [
            pkgs.nodejs
            pkgs.pnpmConfigHook
            pkgs.makeWrapper
          ];
          
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit pname version src;
            hash = "sha256-9rHqfafCKtuwAAj3/N2p/em4ddlWQhM07RhQJR9VTYg=";
            fetcherVersion = 3;
          };
          
          preBuild = ''
            export PNPM_HOME=$PWD/.pnpm-home
            export npm_config_store_dir=$PWD/.pnpm-store
          '';
          
          buildPhase = ''
            runHook preBuild
            
            export HOME=$TMPDIR
            
            echo "Building CSS..."
            pnpm exec tailwindcss -i ./src/input.css -o ./src/tailwind.css --minify
            
            if [ -d "equicord" ]; then
              echo "Building Equicord..."
              cd equicord
              pnpm install --offline --frozen-lockfile
              EQUICORD_HASH=equicord pnpm buildWeb
              if [ ! -d "dist/browser" ] || [ ! -f "dist/browser/browser.js" ]; then
                echo "dist/browser/browser.js not found"
                exit 1
              fi
              cd ..
            else
              echo "Equicord directory not found"
            fi
            
            if [ -d "vencord" ]; then
              echo "Building Vencord..."
              cd vencord
              pnpm install --offline --frozen-lockfile
              VENCORD_HASH=vencord pnpm buildWeb
              if [ ! -f "dist/browser.js" ]; then
                echo "dist/browser.js not found"
                exit 1
              fi
              cd ..
            else
              echo "Vencord directory not found"
            fi
            
            runHook postBuild
          '';
          
          installPhase = ''
            runHook preInstall
            
            mkdir -p $out/share/recar
            cp -r src package.json $out/share/recar/
            cp -r node_modules $out/share/recar/
            
            if [ -d "equicord/dist" ]; then
              echo "Installing Equicord..."
              mkdir -p $out/share/recar/equicord/dist/browser
              cp -r equicord/dist/* $out/share/recar/equicord/dist/
              if [ -f "$out/share/recar/equicord/dist/browser/browser.js" ]; then
                echo "Equicord installed successfully"
              else
                echo "Equicord browser.js not found"
              fi
            fi
            
            if [ -d "vencord/dist" ]; then
              echo "Installing Vencord..."
              mkdir -p $out/share/recar/vencord/dist
              cp -r vencord/dist/* $out/share/recar/vencord/dist/
              if [ -f "$out/share/recar/vencord/dist/browser.js" ]; then
                echo "Vencord installed successfully"
              else
                echo "Vencord browser.js not found"
              fi
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
Comment=A Discord client for Linux with client mods
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
            elif [ -f "src/img/recar.png" ]; then
              cp src/img/recar.png $out/share/icons/hicolor/256x256/apps/recar.png
            fi
            
            runHook postInstall
          '';
          
          meta = with lib; {
            description = "A Discord client for Linux with client mods and extra functionality";
            homepage = "https://cutely.strangled.net/recar";
            license = licenses.mit;
            platforms = platforms.linux;
            maintainers = [ "hamhim" ];
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
