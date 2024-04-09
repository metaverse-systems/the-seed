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
      prefix: tempDir, // or any other default values your Config expects
      scopes: {}
    };
    fs.writeFileSync(path.join(tempDir, 'config.json'), JSON.stringify(defaultConfig));
    config = new Config(tempDir);
    rp = new ResourcePak(config, tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true });
  });

  it("should create a new package", () => {
    const packageName = "@test/package";
    rp.create(packageName);
    expect(rp.package).toBeDefined();
    expect(rp.package?.name).toBe(packageName);
    // Add more assertions as necessary
  });

  it("should add a resource", () => {
    const packageName = "@test/package";
    rp.create(packageName);

    const resourceName = "testResource";
    const fileName = "testFile.txt";
    // Creating a dummy file to add
    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, "Dummy content");
    rp.addResource(resourceName, filePath);

    expect(rp.package?.resources).toContainEqual(expect.objectContaining({
      name: resourceName,
      filename: tempDir + "/" + fileName,
      // size: depends on the content written
    }));
    // Add more assertions as necessary
  });

  it("should save package configuration", () => {
    const packageName = "@test/package";
    rp.create(packageName);
    rp.savePackage();
    const packageJsonPath = path.join(tempDir, "package.json");
    expect(fs.existsSync(packageJsonPath)).toBe(true);
    // Further assertions on the contents of package.json can be added
  });

  // Add more tests for other methods, e.g., build(), as needed.
});
