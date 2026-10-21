#include <{{name}}.hpp>

{{identifier}}::{{identifier}}():
  System("{{package}}")
{
}

{{identifier}}::{{identifier}}(nlohmann::json config):
  System("{{package}}")
{
}

nlohmann::json {{identifier}}::Export() const
{
    nlohmann::json config;
    return config;
}

void {{identifier}}::Initialize()
{
}

void {{identifier}}::Shutdown()
{
}

void {{identifier}}::Update()
{
    double dt = this->ElapsedSecondsGet();
    // dt is the length of this update in seconds: the same however often it is read, and the configured
    // interval on the first update. It is not clamped after a stall, so cap it yourself if you need to.
    // Do some work
}

extern "C"
{
    ecs::System *create_system(void *p)
    {
        if(p == nullptr) return new {{identifier}}();

        nlohmann::json *config = (nlohmann::json *)p;
        return new {{identifier}}(*config);
    }
}
