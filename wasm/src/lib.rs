// WASM wrapper around Brave's `readability` distiller crate.
//
// `distill` takes the raw HTML of a page plus its URL and returns the fully
// distilled document (the same `#article` structure Brave emits, with the
// hardcoded element IDs), or `null` if no article could be extracted.
//
// Built with: wasm-pack build --release --target web
// (after `make vendor-rust BRAVE_SRC=/path/to/brave-core`).

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn distill(html: &str, url: &str) -> Option<String> {
    let mut bytes = html.as_bytes();
    match readability::extractor::extract(&mut bytes, Some(url)) {
        Ok(product) => Some(product.content),
        Err(_) => None,
    }
}
