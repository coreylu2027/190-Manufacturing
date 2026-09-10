"use client";

import { forwardRef, useEffect, useState, type ComponentPropsWithoutRef } from "react";

const MAX_CACHED_FILES = 6;
const MAX_CACHED_BYTES = 256 * 1024 * 1024;

interface PrefetchedFile {
  objectUrl: string;
  byteSize: number;
}

interface CacheEntry {
  promise: Promise<PrefetchedFile | null>;
  file?: PrefetchedFile;
}

const prefetchedFiles = new Map<string, CacheEntry>();
let cachedBytes = 0;

function evict(href: string, entry: CacheEntry) {
  if (prefetchedFiles.get(href) !== entry || !entry.file) return;
  prefetchedFiles.delete(href);
  cachedBytes -= entry.file.byteSize;
  URL.revokeObjectURL(entry.file.objectUrl);
}

function trimCache(currentHref: string) {
  for (const [href, entry] of prefetchedFiles) {
    if (prefetchedFiles.size <= MAX_CACHED_FILES && cachedBytes <= MAX_CACHED_BYTES) break;
    if (href !== currentHref) evict(href, entry);
  }
}

function prefetchFile(href: string) {
  const cached = prefetchedFiles.get(href);
  if (cached) {
    prefetchedFiles.delete(href);
    prefetchedFiles.set(href, cached);
    return cached.promise;
  }

  const entry = {} as CacheEntry;
  entry.promise = fetch(href, {
    cache: "force-cache",
    credentials: "same-origin",
    redirect: "follow",
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Unable to preload manufacturing file (${response.status})`);
      const blob = await response.blob();
      const file = { objectUrl: URL.createObjectURL(blob), byteSize: blob.size };
      entry.file = file;
      cachedBytes += file.byteSize;
      trimCache(href);
      return file;
    })
    .catch(() => {
      if (prefetchedFiles.get(href) === entry) prefetchedFiles.delete(href);
      return null;
    });
  prefetchedFiles.set(href, entry);
  return entry.promise;
}

type ManufacturingFileLinkProps = Omit<ComponentPropsWithoutRef<"a">, "href"> & {
  href: string;
};

/** Silently warm a private manufacturing file in this browser while its link is visible. */
export const ManufacturingFileLink = forwardRef<HTMLAnchorElement, ManufacturingFileLinkProps>(
  function ManufacturingFileLink({ href, ...props }, ref) {
    const [prefetched, setPrefetched] = useState<{ sourceHref: string; objectUrl: string } | null>(() => {
      const objectUrl = prefetchedFiles.get(href)?.file?.objectUrl;
      return objectUrl ? { sourceHref: href, objectUrl } : null;
    });

    useEffect(() => {
      let active = true;
      void prefetchFile(href).then((file) => {
        if (active && file) setPrefetched({ sourceHref: href, objectUrl: file.objectUrl });
      });
      return () => {
        active = false;
      };
    }, [href]);

    const resolvedHref = prefetched?.sourceHref === href ? prefetched.objectUrl : href;
    return <a ref={ref} href={resolvedHref} {...props} />;
  },
);
