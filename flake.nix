{
  description = "panopto-fetch — download + re-encode a whole Panopto folder from a userscript manifest";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems =
        f: nixpkgs.lib.genAttrs supportedSystems (system: f (import nixpkgs { inherit system; }));
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          # panopto-fetch.py is pure stdlib; it only needs a python interpreter
          # and an ffmpeg with libsvtav1 + libx265 + libopus (all in pkgs.ffmpeg).
          # NVENC (--codec nvenc) needs a system ffmpeg + driver; point at it with
          #   FFMPEG=/path/to/system/ffmpeg panopto-fetch --codec nvenc ...
          panopto-fetch = pkgs.writeShellApplication {
            name = "panopto-fetch";
            runtimeInputs = [
              pkgs.python3
              pkgs.ffmpeg
            ];
            text = ''
              exec python3 ${self}/panopto-fetch.py "$@"
            '';
          };
        in
        {
          default = panopto-fetch;
          inherit panopto-fetch;
        }
      );

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/panopto-fetch";
          meta.description = "Download + re-encode a Panopto folder from a manifest";
        };
      });

      devShells = forAllSystems (
        pkgs:
        let
          panopto-fetch = self.packages.${pkgs.stdenv.hostPlatform.system}.panopto-fetch;
        in
        {
          default = pkgs.mkShell {
            packages = [
              panopto-fetch
              pkgs.python3
              pkgs.ffmpeg
              pkgs.jq
            ];
            shellHook = ''
              export PATH="$PWD:$PATH"
              echo "panopto-fetch dev shell — run:  panopto-fetch '<manifest>' -o ~/panopto"
            '';
          };
        }
      );
    };
}
