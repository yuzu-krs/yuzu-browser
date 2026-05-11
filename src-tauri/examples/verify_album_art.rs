// Standalone verification: can we set / read album art on an MP3 the same way
// the Tauri commands do, and does the resulting file expose the picture so
// that Windows Explorer's thumbnail viewer can render it?
//
// Usage:
//   cargo run --example verify_album_art -- <input.mp3> [image.jpg|png]
//
// If [image] is omitted we synthesize a small JPEG in-memory via the `image`
// crate so the test is self-contained.

use std::path::PathBuf;

use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::tag::{Accessor, Tag, TagExt};

fn mime_to_string(m: Option<&MimeType>) -> String {
    match m {
        Some(mt) => mt.to_string(),
        None => "application/octet-stream".to_string(),
    }
}

fn make_test_jpeg() -> Vec<u8> {
    // 64x64 solid orange-red square, encoded as PNG (lofty accepts any image
    // bytes as long as MIME matches; we'll declare PNG mime when we use this).
    use image::{ImageBuffer, Rgb};
    let mut img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::new(64, 64);
    for (_, _, px) in img.enumerate_pixels_mut() {
        *px = Rgb([255, 80, 30]);
    }
    let mut out = std::io::Cursor::new(Vec::<u8>::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .expect("encode png");
    out.into_inner()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: verify_album_art <input.mp3> [image.jpg|png]");
        std::process::exit(2);
    }
    let src = PathBuf::from(&args[1]);
    let img_arg: Option<PathBuf> = args.get(2).map(PathBuf::from);

    let tmp_dir = std::env::temp_dir();
    let mp3 = tmp_dir.join("yuzu_verify_album_art.mp3");
    std::fs::copy(&src, &mp3)?;
    println!("[1] copied {:?} -> {:?}", src, mp3);

    {
        let tagged = lofty::read_from_path(&mp3)?;
        let tag_opt = tagged.primary_tag().or_else(|| tagged.first_tag());
        match tag_opt {
            Some(tag) => println!(
                "[2] before: title={:?} artist={:?} pictures={}",
                tag.title().map(|s| s.to_string()),
                tag.artist().map(|s| s.to_string()),
                tag.pictures().len()
            ),
            None => println!("[2] before: no tags present"),
        }
    }

    let (img_bytes, mime) = match img_arg.as_ref() {
        Some(p) => {
            let bytes = std::fs::read(p)?;
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase());
            let m = match ext.as_deref() {
                Some("jpg") | Some("jpeg") => MimeType::Jpeg,
                Some("png") => MimeType::Png,
                Some("gif") => MimeType::Gif,
                Some("bmp") => MimeType::Bmp,
                Some("tiff") | Some("tif") => MimeType::Tiff,
                _ => MimeType::Jpeg,
            };
            (bytes, m)
        }
        None => (make_test_jpeg(), MimeType::Png),
    };
    let pic = Picture::new_unchecked(PictureType::CoverFront, Some(mime), None, img_bytes.clone());

    {
        let mut tagged = lofty::read_from_path(&mp3)?;
        let primary_type = tagged.primary_tag_type();
        if tagged.primary_tag().is_none() {
            let _ = tagged.insert_tag(Tag::new(primary_type));
        }
        let tag = tagged.primary_tag_mut().expect("tag must exist");
        tag.set_title("YUZU TEST TITLE".to_string());
        tag.set_artist("YUZU TEST ARTIST".to_string());
        tag.set_album("YUZU TEST ALBUM".to_string());
        while !tag.pictures().is_empty() {
            let _ = tag.remove_picture(0);
        }
        tag.push_picture(pic);
        // Match production write path (default WriteOptions = ID3v2.4).
        tag.save_to_path(&mp3, WriteOptions::default())?;
    }
    println!("[3] wrote tags + picture ({} bytes)", img_bytes.len());

    {
        let tagged = lofty::read_from_path(&mp3)?;
        let tag_opt = tagged.primary_tag().or_else(|| tagged.first_tag());
        let tag = tag_opt.ok_or("no primary tag after write")?;
        let title = tag.title().map(|s| s.to_string());
        let artist = tag.artist().map(|s| s.to_string());
        let album = tag.album().map(|s| s.to_string());
        let pic = tag.pictures().first();
        let pic_mime = pic.map(|p| mime_to_string(p.mime_type()));
        let pic_size = pic.map(|p| p.data().len());
        let pic_type = pic.map(|p| format!("{:?}", p.pic_type()));
        // Read the ID3v2 tag directly to check version.
        let v2_version = tagged
            .tag(lofty::tag::TagType::Id3v2)
            .map(|t| {
                // Try to downcast to Id3v2Tag to read original_version.
                // Tag does not expose version directly, so we re-read via Id3v2Tag.
                format!("{:?}", t.tag_type())
            });
        println!("[4] after:  title={:?} artist={:?} album={:?}", title, artist, album);
        println!(
            "[4] picture: mime={:?} size={:?} type={:?} tag_type={:?} v2={:?}",
            pic_mime,
            pic_size,
            pic_type,
            tag.tag_type(),
            v2_version,
        );

        assert_eq!(title.as_deref(), Some("YUZU TEST TITLE"));
        assert_eq!(artist.as_deref(), Some("YUZU TEST ARTIST"));
        assert_eq!(album.as_deref(), Some("YUZU TEST ALBUM"));
        assert!(pic.is_some(), "picture missing after write");
        let pmime = pic_mime.unwrap();
        assert!(
            pmime.starts_with("image/"),
            "mime should be a real MIME string but was {:?}",
            pmime
        );
        assert_eq!(pic_size.unwrap(), img_bytes.len());
    }

    println!("[5] OK: tags persisted + album art readable -> Explorer thumbnail should render.");
    println!("    file: {:?}", mp3);
    Ok(())
}
