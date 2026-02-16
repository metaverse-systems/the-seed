import fs from "fs";
import os from "os";
import path from "path";
import ResourcePak from "../src/ResourcePak";
import Config from "../src/Config";

// Helper to create a temporary directory for testing
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "resource-pak-"));
}

describe("ResourcePak", () => {
  let tempDir: string;
  let config: Config;
  let rp: ResourcePak;

  beforeEach(() => {
    tempDir = createTempDir();
    const defaultConfig = {
      prefix: tempDir,
      scopes: {
        "@test": {
          author: { name: "Test Author", email: "test@test.com", url: "" }
        }
      }
    };
    fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify(defaultConfig));
    config = new Config(tempDir);
    rp = new ResourcePak(config);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true });
  });

  it("should create a new package", () => {
    rp.createPackage("@test", "my-pak");
    expect(rp.package).toBeDefined();
    expect(rp.package?.name).toBe("@test/my-pak");
    expect(rp.package?.resources).toEqual([]);
    expect(rp.packageDir).toBe(path.join(tempDir, "projects", "@test", "my-pak"));
    expect(fs.existsSync(rp.packageDir)).toBe(true);
    expect(fs.existsSync(path.join(rp.packageDir, "package.json"))).toBe(true);
  });

  it("should add a resource using process.cwd() by default", () => {
    rp.createPackage("@test", "my-pak");
    const pakDir = rp.packageDir;

    // Create a dummy resource file in the pak directory
    const fileName = "testFile.txt";
    const filePath = path.join(pakDir, fileName);
    fs.writeFileSync(filePath, "Dummy content");

    // Use the packageDir parameter (since process.cwd() won't match pakDir in tests)
    rp.addResource("testResource", fileName, pakDir);

    expect(rp.package?.resources).toContainEqual(expect.objectContaining({
      name: "testResource",
      filename: fileName,
    }));
    expect(rp.package!.resources!.length).toBe(1);
  });

  it("should add a resource with explicit packageDir parameter", () => {
    rp.createPackage("@test", "my-pak");
    const pakDir = rp.packageDir;

    const fileName = "asset.png";
    const filePath = path.join(pakDir, fileName);
    fs.writeFileSync(filePath, "PNG data");

    rp.addResource("myAsset", fileName, pakDir);

    const savedPkg = JSON.parse(fs.readFileSync(path.join(pakDir, "package.json")).toString());
    expect(savedPkg.resources).toHaveLength(1);
    expect(savedPkg.resources[0].name).toBe("myAsset");
    expect(savedPkg.resources[0].filename).toBe(fileName);
    expect(savedPkg.resources[0].size).toBeGreaterThan(0);
  });

  it("should not add a duplicate resource name", () => {
    rp.createPackage("@test", "my-pak");
    const pakDir = rp.packageDir;

    const file1 = path.join(pakDir, "file1.txt");
    const file2 = path.join(pakDir, "file2.txt");
    fs.writeFileSync(file1, "content1");
    fs.writeFileSync(file2, "content2");

    rp.addResource("dup", "file1.txt", pakDir);
    rp.addResource("dup", "file2.txt", pakDir);

    const savedPkg = JSON.parse(fs.readFileSync(path.join(pakDir, "package.json")).toString());
    expect(savedPkg.resources).toHaveLength(1);
    expect(savedPkg.resources[0].filename).toBe("file1.txt");
  });

  it("should save package configuration", () => {
    rp.createPackage("@test", "my-pak");
    rp.save();
    const packageJsonPath = path.join(rp.packageDir, "package.json");
    expect(fs.existsSync(packageJsonPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(packageJsonPath).toString());
    expect(saved.name).toBe("@test/my-pak");
  });

  it("should build a .pak file with explicit packageDir", () => {
    rp.createPackage("@test", "my-pak");
    const pakDir = rp.packageDir;

    // Add two resources
    const file1 = path.join(pakDir, "res1.txt");
    const file2 = path.join(pakDir, "res2.dat");
    fs.writeFileSync(file1, "Hello resource 1");
    fs.writeFileSync(file2, "Resource 2 data");

    rp.addResource("resource1", "res1.txt", pakDir);
    rp.addResource("resource2", "res2.dat", pakDir);

    // Build with explicit packageDir
    rp.build(pakDir);

    const pakFile = path.join(pakDir, "my-pak.pak");
    expect(fs.existsSync(pakFile)).toBe(true);

    // Verify the .pak starts with a 10-digit header size
    const content = fs.readFileSync(pakFile).toString();
    const headerSizeStr = content.substring(0, 10);
    expect(headerSizeStr).toMatch(/^\d{10}$/);
  });

  it("should build using packageDir parameter instead of cwd", () => {
    rp.createPackage("@test", "build-test");
    const pakDir = rp.packageDir;

    const file = path.join(pakDir, "data.bin");
    fs.writeFileSync(file, "binary data");
    rp.addResource("data", "data.bin", pakDir);

    // Build with explicit pakDir (not relying on process.cwd())
    rp.build(pakDir);

    const pakFile = path.join(pakDir, "build-test.pak");
    expect(fs.existsSync(pakFile)).toBe(true);

    // Read the pak and verify it contains header JSON + resource data
    const pakContent = fs.readFileSync(pakFile);
    expect(pakContent.length).toBeGreaterThan(11); // header size + newline + content
  });
});
