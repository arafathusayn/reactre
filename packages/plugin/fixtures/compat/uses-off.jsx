// A React app for test/bundlers.test.ts that uses useEffect, which the test switches off: the
// build must fail and name it.

import { useEffect } from "react";

export function useTitle(title) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
