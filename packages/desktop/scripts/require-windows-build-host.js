if (process.platform !== 'win32') {
  throw new Error(
    'Build the Windows installer on Windows. The packaged server includes native runtime dependencies that must match the target platform.',
  );
}
