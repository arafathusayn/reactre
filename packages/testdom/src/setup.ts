// Preloaded before every test file (bunfig.toml): a document must exist
// before any test imports code that parses templates when it loads. Test
// files install a fresh one as they need, usually in beforeEach.
import { installFakeDocument } from "./index.ts";

installFakeDocument();
