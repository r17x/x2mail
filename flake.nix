{
  description = "xh2m — HTTP to Mail";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    pre-commit-hooks.url = "github:cachix/pre-commit-hooks.nix";
    pre-commit-hooks.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    inputs:
    inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        inputs.pre-commit-hooks.flakeModule
      ];

      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];

      perSystem =
        {
          pkgs,
          config,
          ...
        }:
        {
          pre-commit.settings.hooks = {
            nixfmt-rfc-style.enable = true;
            deadnix.enable = true;
            oxlint = {
              enable = true;
              name = "oxlint";
              entry = "bun oxlint";
              files = "\\.(ts|tsx|js|jsx)$";
              pass_filenames = false;
              language = "system";
            };
            oxfmt = {
              enable = true;
              name = "oxfmt";
              entry = "bun oxfmt src -- --check";
              files = "\\.(ts|tsx|js|jsx)$";
              pass_filenames = false;
              language = "system";
            };
            typecheck = {
              enable = true;
              name = "typecheck";
              entry = "bun run typecheck";
              files = "\\.(ts|tsx)$";
              pass_filenames = false;
              language = "system";
            };
            tests = {
              enable = true;
              name = "tests";
              entry = "bun run test";
              files = "\\.(ts|tsx)$";
              pass_filenames = false;
              language = "system";
            };
          };

          devShells.default = pkgs.mkShell {
            shellHook = ''
              ${config.pre-commit.installationScript}
              export PATH="$PWD/node_modules/.bin:$PATH"
            '';
            packages = [
              pkgs.bun
              pkgs.nodejs-slim
              pkgs.sops
              pkgs.age
              pkgs.yq-go
              config.pre-commit.settings.package
            ]
            ++ config.pre-commit.settings.enabledPackages;
          };

          devShells.ci = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.nodejs-slim
              pkgs.sops
              pkgs.age
              pkgs.yq-go
            ];
          };
        };
    };
}
