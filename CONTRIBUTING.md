# Contributing to OpsTrellis

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and ideas

- **Bugs:** [open a bug report](https://github.com/mtr1920/opstrellis/issues/new?template=bug_report.yml)
  with your version (Settings → About), OS and provider. Log lines (Settings → About → Show logs)
  help a lot; they contain timings and errors, never what you said.
- **Ideas:** [open a feature request](https://github.com/mtr1920/opstrellis/issues/new?template=feature_request.yml)
  describing the problem you want solved.
- **Security issues:** please report them privately; see [SECURITY.md](SECURITY.md).

## Pull requests

1. For anything larger than a small fix, open an issue first so we can agree on the approach.
2. Keep changes focused: one fix or feature per pull request.
3. Run the checks:
   ```sh
   cd desktop && npm run build                 # type-check and build the UI
   cd src-tauri && cargo test                  # Rust tests
   python3 ../../tests/test_installer.py       # if you touched install.sh
   ```
4. Describe what changed, why, and how you tested it (which OS, which provider).

Development setup is in the [README](README.md#development); architecture notes are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License of contributions

OpsTrellis is licensed under the [MIT License](LICENSE). By submitting a contribution you confirm
that you wrote it (or have the right to submit it) and agree that it is licensed under the same
MIT License.
