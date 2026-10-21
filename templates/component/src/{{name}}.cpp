#include <{{name}}.hpp>

{{identifier}}::{{identifier}}()
{
    this->Type = "{{package}}";
}

{{identifier}}::{{identifier}}(nlohmann::json config)
{
    this->Type = "{{package}}";
}

nlohmann::json {{identifier}}::Export() const
{
    nlohmann::json config;
    return config;
}

extern "C"
{
    ecs::Component *create_component(void *p)
    {
        if(p == nullptr)
        {
            return new {{identifier}}();
        }

        nlohmann::json *config = (nlohmann::json *)p;
        return new {{identifier}}(*config);
    }
}
