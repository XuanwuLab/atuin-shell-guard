const platform = process.env.ASG_TEST_PLATFORM;

if (platform === 'win32' || platform === 'linux' || platform === 'darwin') {
  Object.defineProperty(process, 'platform', { value: platform });
}
